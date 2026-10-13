import { extractFacts, updateRollingSummary, type Logger } from "@aidp/ai";
import {
  AnalysisService,
  AttachmentService,
  PrismaPromptSource,
  PrismaSessionStore,
  RequirementsService,
  deleteSessionData,
  runRetentionSweep,
  type CallerFactory,
  type Crypto,
  type EmailPort,
  type HealthSweep,
  type JobName,
  type JobPayload,
  type JobPublisher,
  type SettingsService,
  type StoragePort,
} from "@aidp/core";
import { withSystemTenant, withTenant } from "@aidp/db";
import type { Prisma, PrismaClient } from "@prisma/client";

export interface HandlerDeps {
  db: PrismaClient;
  callers: CallerFactory;
  settings: SettingsService;
  email: EmailPort;
  jobs: JobPublisher;
  log: Logger;
  crypto: Crypto;
  publicWebUrl: string;
  /** Where uploaded audio and documents live; the worker reads what the API wrote. */
  storage: StoragePort;
  /** The `ops.health-sweep` job (D-92). */
  health: HealthSweep;
}

/**
 * Job handlers (spec 12, NFR-09). Each is idempotent: the engine records the sequence it
 * summarized or extracted up to, so a retried job does no duplicate work.
 */
export type Handlers = { [N in JobName]: (payload: JobPayload<N>) => Promise<void> };

/**
 * A job runs fenced in exactly like a request does: the tenant comes from its payload, so the
 * row-level security policies apply to background work too. A job without a tenant sweeps every
 * one of them and runs as system. This lives on the handler rather than the consume loop so a
 * handler called directly — a test, a retry tool — is fenced the same way.
 */
const scoped = <P>(handler: (payload: P) => Promise<void>) => {
  return (payload: P): Promise<void> => {
    const companyId = (payload as { companyId?: string }).companyId;
    return companyId
      ? withTenant(companyId, () => handler(payload))
      : withSystemTenant(() => handler(payload));
  };
};

export function handlers(deps: HandlerDeps): Handlers {
  const store = new PrismaSessionStore(deps.db);
  const prompts = new PrismaPromptSource(deps.db);
  const analysis = new AnalysisService({
    db: deps.db,
    callers: deps.callers,
    settings: deps.settings,
    jobs: deps.jobs,
    log: deps.log,
  });
  // GitHub pushes happen in the API process; the worker only generates versions.
  const requirements = new RequirementsService({
    db: deps.db,
    callers: deps.callers,
    settings: deps.settings,
    jobs: deps.jobs,
    log: deps.log,
    email: deps.email,
    publicWebUrl: deps.publicWebUrl,
    crypto: deps.crypto,
  });

  return {
    "session.summarize": scoped(
      async ({ sessionId, companyId }: JobPayload<"session.summarize">): Promise<void> => {
        const session = await store.snapshot(sessionId);
        if (session.status === "deleted") return;
        const window = await deps.settings.get("engine.recentWindowTurns", [
          { scope: "template" as const, scopeId: "" },
          { scope: "tenant" as const, scopeId: companyId },
        ]);
        const caller = await deps.callers.forCompany(companyId);
        const r = await updateRollingSummary({ caller, store, prompts }, session, window);
        deps.log.info("summary updated", { sessionId, ...r });
      },
    ),

    "session.extract": scoped(
      async ({ sessionId, companyId }: JobPayload<"session.extract">): Promise<void> => {
        const session = await store.snapshot(sessionId);
        if (session.status === "deleted") return;
        const caller = await deps.callers.forCompany(companyId);
        const r = await extractFacts({ caller, store, prompts }, session);
        for (const f of r.facts) {
          await deps.db.fact.create({
            data: {
              companyId,
              sessionId,
              kind: f.kind,
              payload: f as Prisma.InputJsonValue,
              extractorVersion: "extraction@1",
            },
          });
        }
        deps.log.info("facts extracted", { sessionId, count: r.facts.length, upToSeq: r.upToSeq });
      },
    ),

    "email.send": scoped(async (m: JobPayload<"email.send">): Promise<void> => {
      await deps.email.send({
        to: m.to,
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        ...(m.companyId ? { companyId: m.companyId } : {}),
      });
    }),

    /**
     * Reads an uploaded file once, so every later turn is cheap (FR-31). The caller is built per
     * tenant, because routing, prices and budgets are the tenant's.
     */
    "attachment.ingest": scoped(
      async ({ attachmentId, companyId }: JobPayload<"attachment.ingest">): Promise<void> => {
        const caller = await deps.callers.forCompany(companyId);
        await new AttachmentService({
          db: deps.db,
          storage: deps.storage,
          settings: deps.settings,
          log: deps.log,
          prompts,
          caller,
        }).ingest(companyId, attachmentId);
      },
    ),

    /** Second pass of "delete my data": removes anything the request path could not (facts written later, ledger references). */
    "privacy.delete-session": scoped(
      async ({ sessionId, companyId }: JobPayload<"privacy.delete-session">): Promise<void> => {
        await deleteSessionData(deps.db, sessionId, {
          storage: deps.storage,
          companyId,
          log: deps.log,
        });
        deps.log.info("session data deleted", { sessionId });
      },
    ),

    /**
     * Retention enforcement for every tenant (spec 11). Scheduled daily; safe to run by hand,
     * since a sweep that finds nothing expired does nothing.
     */
    "privacy.retention-sweep": scoped(async (): Promise<void> => {
      const sweeps = await runRetentionSweep({
        db: deps.db,
        settings: deps.settings,
        log: deps.log,
        // Without this the sweep deletes the rows and leaves the recorded audio on disk forever,
        // unreferenced and undiscoverable, which is the one outcome the retention promise cannot
        // survive.
        storage: deps.storage,
      });
      const deleted = sweeps.reduce((n, s) => n + s.deleted, 0);
      deps.log.info("retention sweep finished", { tenants: sweeps.length, deleted });
    }),

    /** Expired Auth.js sign-in tokens (spec 11). Nothing references them once they lapse. */
    "auth.prune-verification-tokens": scoped(async (): Promise<void> => {
      const { count } = await deps.db.verificationToken.deleteMany({
        where: { expires: { lt: new Date() } },
      });
      deps.log.info("verification tokens pruned", { deleted: count });
    }),

    /** Collective analysis for a campaign (spec 04). Idempotent per analysis id. */
    "analysis.run": scoped(async ({ analysisId }: JobPayload<"analysis.run">): Promise<void> => {
      await analysis.run(analysisId);
    }),

    /** One specification version for a requirements session (spec 05, FR-24). Idempotent per version id. */
    "spec.generate": scoped(async ({ versionId }: JobPayload<"spec.generate">): Promise<void> => {
      await requirements.runGeneration(versionId);
    }),

    /**
     * The five-minute look at everything that fails without anyone calling (D-92): stuck jobs,
     * dead letters, backups, the disk, provider error rates. It reads and alerts; it fixes nothing.
     */
    "ops.health-sweep": scoped(async (): Promise<void> => {
      const r = await deps.health.run();
      deps.log.info("health sweep finished", { raised: r.raised.length, resolved: r.resolved.length });
    }),
  };
}

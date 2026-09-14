import { extractFacts, updateRollingSummary, type Logger } from "@aidp/ai";
import {
  AnalysisService,
  PrismaPromptSource,
  PrismaSessionStore,
  RequirementsService,
  type CallerFactory,
  type Crypto,
  type EmailPort,
  type JobName,
  type JobPayload,
  type JobPublisher,
  type SettingsService,
} from "@aidp/core";
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
}

/**
 * Job handlers (spec 12, NFR-09). Each is idempotent: the engine records the sequence it
 * summarized or extracted up to, so a retried job does no duplicate work.
 */
export type Handlers = { [N in JobName]: (payload: JobPayload<N>) => Promise<void> };

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
    "session.summarize": async ({ sessionId, companyId }: JobPayload<"session.summarize">): Promise<void> => {
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

    "session.extract": async ({ sessionId, companyId }: JobPayload<"session.extract">): Promise<void> => {
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

    "email.send": async (m: JobPayload<"email.send">): Promise<void> => {
      await deps.email.send({
        to: m.to,
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        ...(m.companyId ? { companyId: m.companyId } : {}),
      });
    },

    /** Second pass of "delete my data": removes anything the request path could not (facts written later, ledger references). */
    "privacy.delete-session": async ({ sessionId }: JobPayload<"privacy.delete-session">): Promise<void> => {
      await deps.db.$transaction([
        deps.db.message.deleteMany({ where: { sessionId } }),
        deps.db.sessionEvent.deleteMany({ where: { sessionId } }),
        deps.db.fact.deleteMany({ where: { sessionId } }),
        deps.db.attachment.deleteMany({ where: { sessionId } }),
        deps.db.session.update({
          where: { id: sessionId },
          data: { status: "deleted", state: {}, summary: "" },
        }),
      ]);
      deps.log.info("session data deleted", { sessionId });
    },

    /** Collective analysis for a campaign (spec 04). Idempotent per analysis id. */
    "analysis.run": async ({ analysisId }: JobPayload<"analysis.run">): Promise<void> => {
      await analysis.run(analysisId);
    },

    /** One specification version for a requirements session (spec 05, FR-24). Idempotent per version id. */
    "spec.generate": async ({ versionId }: JobPayload<"spec.generate">): Promise<void> => {
      await requirements.runGeneration(versionId);
    },
  };
}

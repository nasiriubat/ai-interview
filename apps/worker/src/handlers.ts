import {
  extractFacts,
  updateRollingSummary,
  type Logger,
  type PromptSource,
  type SessionSnapshot,
  type SessionStore,
} from "@aidp/ai";
import {
  AnalysisService,
  AttachmentService,
  EMAIL_OUTBOX_RETENTION_MS,
  PrismaEmailOutbox,
  PrismaPromptSource,
  PrismaSessionStore,
  RequirementsService,
  TenantNotices,
  deleteSessionData,
  deletionNotice,
  previousMonth,
  rekeyAll,
  runRetentionSweep,
  verifyAuditChain,
  sendOnce,
  type AlertPort,
  type CallerFactory,
  type Crypto,
  type EmailOutbox,
  type EmailPort,
  type ErasureLedger,
  type HealthSweep,
  type JobName,
  type JobPayload,
  type JobPublisher,
  type SettingsService,
  type StatementService,
  type StoragePort,
  type TenantExporter,
  type TenantGate,
  type TenantPurger,
} from "@aidp/core";
import { withSystemTenant, withTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";

export interface HandlerDeps {
  db: PrismaClient;
  callers: CallerFactory;
  settings: SettingsService;
  email: EmailPort;
  jobs: JobPublisher;
  log: Logger;
  crypto: Crypto;
  publicWebUrl: string;
  /** Where tenant notices go (D-181). Absent: nobody is mailed about analyses and specifications. */
  alerts?: AlertPort;
  /** Where uploaded audio and documents live; the worker reads what the API wrote. */
  storage: StoragePort;
  /** What has been sent, by idempotency key. Defaults to the Postgres table; tests pass memory. */
  outbox?: EmailOutbox;
  /** Where session state lives. Defaults to Prisma; tests pass `MemorySessionStore`. */
  sessions?: JobSessionStore;
  /** Where prompts come from. Defaults to the tenant-aware Prisma source. */
  prompts?: PromptSource;
  /** A suspended tenant's jobs are acknowledged and skipped (S8); deletion jobs still run. */
  tenants: TenantGate;
  /** The `ops.health-sweep` job (D-92). */
  health?: HealthSweep;
  /** The monthly statement (D-224). Without it the `billing.statement` job fails loudly. */
  statements?: StatementService;
  /** Tenant export and offboarding (D-225, D-226). */
  exporter?: TenantExporter;
  purger?: TenantPurger;
  /** Where erasures are recorded so a restore can re-apply them (D-226). */
  erasures?: ErasureLedger;
}

/** The session store a job needs: the engine's port plus loading a snapshot with its status. */
export type JobSessionStore = SessionStore & {
  snapshot(sessionId: string): Promise<SessionSnapshot & { status: string }>;
};

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
  /**
   * `scoped`, and refused for a suspended tenant (S8). The job is acknowledged rather than failed:
   * retrying a job for a tenant that is suspended on purpose would only fill the dead-letter queue.
   * Work skipped here is not lost to the data; it is simply not started, and an admin re-runs
   * what they need once the tenant is active again. Privacy jobs do not use this wrapper:
   * a deletion obligation does not pause with the account.
   */
  const active = <P extends { companyId?: string | undefined }>(
    name: string,
    handler: (payload: P) => Promise<void>,
  ) =>
    scoped(async (payload: P): Promise<void> => {
      if (payload.companyId && !(await deps.tenants.isActive(payload.companyId))) {
        deps.log.warn("job skipped: tenant suspended", { job: name, companyId: payload.companyId });
        return;
      }
      await handler(payload);
    });

  const store: JobSessionStore = deps.sessions ?? new PrismaSessionStore(deps.db);
  const outbox = deps.outbox ?? new PrismaEmailOutbox(deps.db);
  const prompts = deps.prompts ?? new PrismaPromptSource(deps.db);
  const notices = deps.alerts
    ? new TenantNotices({ alerts: deps.alerts, publicWebUrl: deps.publicWebUrl, log: deps.log })
    : undefined;
  const analysis = new AnalysisService({
    db: deps.db,
    callers: deps.callers,
    settings: deps.settings,
    jobs: deps.jobs,
    log: deps.log,
    ...(notices ? { notices } : {}),
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
    ...(notices ? { notices } : {}),
  });

  return {
    "session.summarize": active(
      "session.summarize",
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

    "session.extract": active(
      "session.extract",
      async ({ sessionId, companyId }: JobPayload<"session.extract">): Promise<void> => {
        const session = await store.snapshot(sessionId);
        if (session.status === "deleted") return;
        const caller = await deps.callers.forCompany(companyId);
        // The facts, the cursor and the event are committed per batch inside extractFacts. There is
        // nothing left for this handler to persist, which is the point: a crash here can no longer
        // leave a cursor that has moved past facts nobody wrote.
        const r = await extractFacts({ caller, store, prompts }, session);
        if (r.stale)
          deps.log.info("extraction yielded to a concurrent run", { sessionId, upToSeq: r.upToSeq });
        else deps.log.info("facts extracted", { sessionId, count: r.facts.length, upToSeq: r.upToSeq });
      },
    ),

    /**
     * Send-once: the queue retries a job whose acknowledgement failed, and without the outbox
     * that is a second email. A retry that finds the message already sent does nothing; one that
     * finds another attempt in flight throws, so the queue tries again later. The log carries the
     * key, never the address.
     */
    "email.send": active("email.send", async (m: JobPayload<"email.send">): Promise<void> => {
      const outcome = await sendOnce(
        outbox,
        deps.email,
        m.idempotencyKey,
        {
          to: m.to,
          subject: m.subject,
          text: m.text,
          ...(m.html ? { html: m.html } : {}),
          ...(m.companyId ? { companyId: m.companyId } : {}),
        },
        m.companyId ? { companyId: m.companyId } : {},
      );
      deps.log.info(outcome === "sent" ? "email sent" : "email already sent; skipped", {
        key: m.idempotencyKey,
      });
    }),

    /**
     * Reads an uploaded file once, so every later turn is cheap (FR-31). The caller is built per
     * tenant, because routing, prices and budgets are the tenant's.
     */
    "attachment.ingest": active(
      "attachment.ingest",
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
        const { bytesFailed } = await deleteSessionData(deps.db, sessionId, {
          storage: deps.storage,
          companyId,
          log: deps.log,
          crypto: deps.crypto,
        });
        // The rows are gone and re-running is harmless, so a failed file delete is retried by the
        // queue (with backoff) instead of waiting for the nightly storage GC to notice it.
        if (bytesFailed > 0) throw new Error(`could not delete the stored files of session ${sessionId}`);
        // After the bytes: the entry says the session is gone, which is true only now. A restore
        // from an older backup finds it in the file and queues this job again (D-226).
        await deps.erasures?.record({ kind: "session", targetId: sessionId, companyId: companyId });
        deps.log.info("session data deleted", { sessionId });
      },
    ),

    /**
     * "Your answers were deleted" for an identified participant (FR-13, D-175). Send-once under
     * `deletion-notice:<session>`, so the queue's retries cannot mail twice. Runs for a suspended
     * tenant too: it is part of honouring a deletion. The address is decrypted here, used, and
     * not logged or kept.
     */
    "privacy.confirm-deletion": scoped(async (m: JobPayload<"privacy.confirm-deletion">): Promise<void> => {
      const outcome = await sendOnce(
        outbox,
        deps.email,
        `deletion-notice:${m.sessionId}`,
        deletionNotice({
          to: deps.crypto.decrypt(m.toEnc),
          companyId: m.companyId,
          campaignName: m.campaignName,
          language: m.language,
          deletedAt: new Date(m.deletedAt),
        }),
        { companyId: m.companyId },
      );
      deps.log.info(outcome === "sent" ? "deletion notice sent" : "deletion notice already sent", {
        sessionId: m.sessionId,
      });
    }),

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
        crypto: deps.crypto,
      });
      const deleted = sweeps.reduce((n, s) => n + s.deleted, 0);
      const orphans = sweeps.reduce((n, s) => n + s.orphansCollected, 0);
      const bytesFailed = sweeps.reduce((n, s) => n + s.bytesFailed, 0);
      // The send-once rows only need to outlive the queue's retries; a month is generous.
      const emailsPruned = await outbox.prune(new Date(Date.now() - EMAIL_OUTBOX_RETENTION_MS));
      deps.log.info("retention sweep finished", {
        tenants: sweeps.length,
        deleted,
        orphans,
        bytesFailed,
        emailsPruned,
      });
    }),

    /** Expired Auth.js sign-in tokens (spec 11). Nothing references them once they lapse. */
    "auth.prune-verification-tokens": scoped(async (): Promise<void> => {
      const { count } = await deps.db.verificationToken.deleteMany({
        where: { expires: { lt: new Date() } },
      });
      deps.log.info("verification tokens pruned", { deleted: count });
    }),

    /** Collective analysis for a campaign (spec 04). Idempotent per analysis id. */
    "analysis.run": active(
      "analysis.run",
      async ({ analysisId }: JobPayload<"analysis.run">): Promise<void> => {
        await analysis.run(analysisId);
      },
    ),

    /** One specification version for a requirements session (spec 05, FR-24). Idempotent per version id. */
    "spec.generate": active(
      "spec.generate",
      async ({ versionId }: JobPayload<"spec.generate">): Promise<void> => {
        await requirements.runGeneration(versionId);
      },
    ),

    /**
     * Moves every stored secret to the active platform key (P9, D-164). Counts only are logged:
     * what was read and rewritten is secret material and never appears in a log line.
     */
    "crypto.rekey": scoped(async (): Promise<void> => {
      const r = await rekeyAll(deps.db, deps.crypto);
      deps.log.info("secrets re-encrypted under the active key", { ...r });
      if (r.unreadable > 0) {
        deps.log.warn("some secrets could not be read with any key in the ring", {
          unreadable: r.unreadable,
        });
      }
    }),

    /**
     * Recomputes every tenant's audit hash chain and logs the chain heads (A2, D-163). The heads
     * go to the log so a copy exists outside the table; a chain that does not verify throws, so the
     * job dead-letters and the health sweep raises it. The row ids are logged, never their content.
     */
    "audit.verify": scoped(async (): Promise<void> => {
      const report = await verifyAuditChain(deps.db);
      for (const head of report.heads) {
        deps.log.info("audit chain head", { companyId: head.companyId, seq: head.seq, hash: head.hash });
      }
      if (report.problems.length > 0) {
        for (const p of report.problems.slice(0, 50)) {
          deps.log.warn("audit chain broken", {
            companyId: p.companyId,
            seq: p.seq,
            id: p.id,
            problem: p.problem,
          });
        }
        throw new Error(`audit chain verification failed for ${report.problems.length} row(s)`);
      }
      deps.log.info("audit chains verified", { tenants: report.heads.length });
    }),

    /**
     * The five-minute look at everything that fails without anyone calling (D-92): stuck jobs,
     * dead letters, backups, the disk, provider error rates. It reads and alerts; it fixes nothing.
     */
    "ops.health-sweep": scoped(async (): Promise<void> => {
      // Optional so that a caller that builds handlers for the jobs it cares about (a test) need
      // not build the sweep; the worker always passes it, and a missing one is an error, not a no-op.
      if (!deps.health) throw new Error("ops.health-sweep ran without a HealthSweep configured");
      const r = await deps.health.run();
      deps.log.info("health sweep finished", { raised: r.raised.length, resolved: r.resolved.length });
    }),

    /**
     * Freezes a month of every tenant's usage and cost (D-224). With no month it is the one that
     * just ended, so the cron on the 1st needs no argument; with `force` it redoes one. One
     * tenant failing is reported and does not stop the others, and fails the job so it is retried
     * (statements that exist are left alone, so a retry only does what is missing).
     */
    "billing.statement": scoped(async (p: JobPayload<"billing.statement">): Promise<void> => {
      if (!deps.statements) throw new Error("billing.statement ran without a StatementService configured");
      const month = p.month ?? previousMonth(new Date());
      const r = await deps.statements.freezeAll(month, {
        ...(p.force ? { force: true } : {}),
        ...(p.companyId ? { companyId: p.companyId } : {}),
        onError: (companyId, err) => {
          deps.log.warn("statement failed", { companyId, month, error: String(err) });
        },
      });
      deps.log.info("statements frozen", {
        month,
        created: r.created.length,
        existing: r.existing.length,
        failed: r.failed.length,
      });
      if (r.failed.length > 0) throw new Error(`statements failed for ${r.failed.length} tenant(s)`);
    }),

    /** A signed, sealed archive of a tenant's data (D-225). Read-only; runs for a suspended tenant too. */
    "tenant.export": scoped(async (p: JobPayload<"tenant.export">): Promise<void> => {
      if (!deps.exporter) throw new Error("tenant.export ran without a TenantExporter configured");
      const meta = await deps.exporter.run(p.companyId, p.requestedBy);
      deps.log.info("tenant export written", {
        stamp: meta.stamp,
        bytes: meta.bytes,
        files: meta.files,
        skippedFiles: meta.skippedFiles,
      });
    }),

    /**
     * Removes a tenant's data (D-226). Not behind `active`: the tenant is suspended by design, and
     * an erasure obligation does not pause with the account.
     */
    "tenant.offboard": scoped(async (p: JobPayload<"tenant.offboard">): Promise<void> => {
      if (!deps.purger) throw new Error("tenant.offboard ran without a TenantPurger configured");
      if (p.graceCheck) {
        const c = await withSystemTenant(async () =>
          deps.db.company.findUnique({ where: { id: p.companyId }, select: { status: true } }),
        );
        if (c?.status !== "suspended") {
          // Reactivated during the grace period: the operator changed their mind, which is the
          // cancellation. Nothing is removed and nothing is retried.
          deps.log.info("offboarding cancelled: the tenant is no longer suspended", {
            companyId: p.companyId,
            status: c?.status ?? "missing",
          });
          return;
        }
      }
      await deps.purger.run(p.companyId, p.requestedBy);
    }),
  };
}

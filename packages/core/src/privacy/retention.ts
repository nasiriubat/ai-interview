import type { Logger } from "@aidp/ai";
import { tenantBatch, withTenant } from "@aidp/db";
import { type Prisma, type PrismaClient } from "@prisma/client";
import type { SettingsService } from "../settings/service.js";

/**
 * Retention enforcement (spec 11: "retention period per tenant (default 24 months) with automatic
 * deletion jobs"). The consent text promises participants their answers do not live forever, so the
 * promise is kept by a daily sweep rather than by hand.
 *
 * Expired sessions are anonymized, not dropped: the messages, events, facts and attachments go, the
 * session row stays as `status: "deleted"` with empty state and summary. Campaign participation
 * counts, analyses and the `LlmCall` cost ledger reference sessions, and those aggregates must
 * survive a deletion (spec 11: "aggregated cluster counts remain").
 *
 * Note on audio: `privacy.audioRetentionDays` is in the catalog but recorded audio only arrives in
 * phase 4, so this sweep does not touch audio and does not pretend to. See the comment at the key.
 *
 * Note on tenancy: the sweep spans every company, but no statement it runs does. It enters each
 * tenant's scope in turn (`withTenant`) and writes through `tenantBatch`, so row-level security
 * stays engaged rather than being stood down for the job.
 */

/** Sessions loaded and anonymized per transaction. */
export const RETENTION_BATCH_SIZE = 200;
/**
 * Batches per tenant per run: a bounded sweep cannot sit on a huge table for an hour. 50 x 200 is
 * 10 000 sessions a tenant a night — measured at roughly a second — and a tenant with more than
 * that expired at once drains over the following nights instead of in one long transaction storm.
 */
export const RETENTION_MAX_BATCHES = 50;

export const RETENTION_SWEEP_ACTION = "privacy.retention_sweep";

/** Anything that can run the four deletes and the anonymizing update. */
type SessionDeleteClient = Pick<PrismaClient, "message" | "sessionEvent" | "fact" | "attachment" | "session">;

export interface TenantSweep {
  companyId: string;
  /** Expired sessions loaded this run. */
  examined: number;
  /** Sessions anonymized this run. */
  deleted: number;
  retentionMonths: number;
  olderThan: string;
  /** The per-run batch cap was reached; the rest is swept by the next run. */
  truncated: boolean;
}

export interface RetentionSweepDeps {
  db: PrismaClient;
  settings: SettingsService;
  log: Logger;
  now?: () => Date;
  batchSize?: number;
  maxBatches?: number;
}

/**
 * Removes everything a participant contributed to one session and anonymizes the row. Shared by the
 * participant "delete my data" path, its `privacy.delete-session` follow-up job, and the retention
 * sweep, so there is one definition of what deletion means.
 */
export async function deleteSessionData(
  db: PrismaClient,
  sessionId: string,
  options: { markEnded?: boolean } = {},
): Promise<void> {
  await tenantBatch(db, deleteSessionOps(db, [sessionId], options));
}

/** The five statements that make a session's content go away, for one id or a whole batch. */
function deleteSessionOps(
  db: SessionDeleteClient,
  sessionIds: string[],
  options: { markEnded?: boolean } = {},
): Prisma.PrismaPromise<unknown>[] {
  const where = { sessionId: { in: sessionIds } };
  return [
    db.message.deleteMany({ where }),
    db.sessionEvent.deleteMany({ where }),
    db.fact.deleteMany({ where }),
    db.attachment.deleteMany({ where }),
    db.session.updateMany({
      where: { id: { in: sessionIds } },
      data: {
        status: "deleted",
        state: {},
        summary: "",
        // The sweep leaves `endedAt` alone: it is what the expiry is measured from.
        ...(options.markEnded ? { endedAt: new Date() } : {}),
      },
    }),
  ];
}

/** `now` minus `months`, in UTC. */
export function retentionCutoff(now: Date, months: number): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/**
 * A session is expired when it ended before the cutoff, or, if it never ended (abandoned halfway),
 * when it was created before it. Already anonymized rows are excluded, which is what makes a second
 * run in a row a no-op.
 */
function expiredWhere(companyId: string, cutoff: Date): Prisma.SessionWhereInput {
  return {
    companyId,
    status: { not: "deleted" },
    OR: [{ endedAt: { lt: cutoff } }, { endedAt: null, createdAt: { lt: cutoff } }],
  };
}

/** The effective retention window for one tenant: tenant setting, else platform, else the default. */
export async function retentionMonthsFor(settings: SettingsService, companyId: string): Promise<number> {
  return settings.get("privacy.retentionMonths", [{ scope: "tenant", scopeId: companyId }]);
}

/**
 * Sweeps every tenant. Idempotent: a session it anonymized no longer matches, so running it twice in
 * a row deletes nothing the second time.
 */
export async function runRetentionSweep(deps: RetentionSweepDeps): Promise<TenantSweep[]> {
  const { db, settings, log } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const batchSize = deps.batchSize ?? RETENTION_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? RETENTION_MAX_BATCHES;

  const companies = await db.company.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const sweeps: TenantSweep[] = [];
  for (const company of companies) {
    // One tenant at a time, inside that tenant's scope: the job spans companies, its statements
    // never do, so row-level security stays engaged for every delete it makes.
    sweeps.push(
      await withTenant(company.id, () =>
        sweepTenant({ db, settings, log }, company.id, now, batchSize, maxBatches),
      ),
    );
  }
  return sweeps;
}

async function sweepTenant(
  deps: { db: PrismaClient; settings: SettingsService; log: Logger },
  companyId: string,
  now: Date,
  batchSize: number,
  maxBatches: number,
): Promise<TenantSweep> {
  const { db, settings, log } = deps;
  const retentionMonths = await retentionMonthsFor(settings, companyId);
  const cutoff = retentionCutoff(now, retentionMonths);
  const where = expiredWhere(companyId, cutoff);

  let examined = 0;
  let deleted = 0;
  let truncated = false;
  for (let batch = 0; batch < maxBatches; batch++) {
    const expired = await db.session.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: batchSize,
    });
    if (expired.length === 0) break;
    examined += expired.length;
    // One transaction per batch, never one per sweep: a long transaction on a big table blocks
    // vacuum and holds locks for the whole run.
    await tenantBatch(
      db,
      deleteSessionOps(
        db,
        expired.map((s) => s.id),
      ),
    );
    deleted += expired.length;
    if (expired.length < batchSize) break;
    if (batch === maxBatches - 1) truncated = true;
  }

  const result: TenantSweep = {
    companyId,
    examined,
    deleted,
    retentionMonths,
    olderThan: cutoff.toISOString(),
    truncated,
  };
  // Structured, and free of participant identifiers: counts and the policy only.
  log.info("retention sweep", { ...result });
  if (deleted > 0) {
    await db.auditLog.create({
      data: {
        companyId,
        actorId: null,
        action: RETENTION_SWEEP_ACTION,
        targetType: "company",
        targetId: companyId,
        diff: { deleted, retentionMonths, olderThan: result.olderThan } satisfies Prisma.InputJsonValue,
      },
    });
  }
  return result;
}

export interface RetentionStatus {
  retentionMonths: number;
  oldestSessionAt: string | null;
  expiredSessions: number;
  lastSweepAt: string | null;
}

/**
 * What an admin needs to answer "is our data actually being deleted?": the window in force, how far
 * back the data goes, how much is currently past the window (zero between sweeps), and when the last
 * sweep that removed something ran. Counts and one min() — cheap enough for a dashboard.
 */
export async function retentionStatus(
  deps: { db: PrismaClient; settings: SettingsService; now?: () => Date },
  companyId: string,
): Promise<RetentionStatus> {
  const { db, settings } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const retentionMonths = await retentionMonthsFor(settings, companyId);
  const cutoff = retentionCutoff(now, retentionMonths);
  const [oldest, expiredSessions, lastSweep] = await Promise.all([
    db.session.aggregate({ where: { companyId, status: { not: "deleted" } }, _min: { createdAt: true } }),
    db.session.count({ where: expiredWhere(companyId, cutoff) }),
    db.auditLog.findFirst({
      where: { companyId, action: RETENTION_SWEEP_ACTION },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  return {
    retentionMonths,
    oldestSessionAt: oldest._min.createdAt?.toISOString() ?? null,
    expiredSessions,
    lastSweepAt: lastSweep?.createdAt.toISOString() ?? null,
  };
}

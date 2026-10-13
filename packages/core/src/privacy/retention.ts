import type { Logger } from "@aidp/ai";
import { tenantBatch, withTenant } from "@aidp/db";
import { type Prisma, type PrismaClient } from "@prisma/client";
import type { SettingsService } from "../settings/service.js";
import { companyPrefix, sessionPrefix, type StoragePort } from "../storage/index.js";

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
 * Note on stored bytes: from phase 4 a session can own recorded audio and uploaded documents, which
 * live in object storage rather than in Postgres. Deleting the `Attachment` rows alone would leave
 * the bytes on disk forever, unreferenced and undiscoverable — the worst possible outcome, since
 * the data is still there but nothing knows it is. Callers pass a `StoragePort` and the session's
 * whole key prefix goes with the rows. Deleting by prefix rather than by row is deliberate: a row
 * lost to an earlier partial failure would otherwise strand its bytes permanently.
 *
 * Bytes that outlive their rows anyway (the object store was down for the delete, the process died
 * between the two, a database was restored from a backup) are found by the storage GC pass at the
 * end of every tenant sweep: it lists the tenant's session directories and removes the ones with
 * no live session behind them (D-103). That pass is why a failed delete is safe to log and carry
 * on from, and it is the thing that makes the "next sweep removes it" claim below true.
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

/**
 * Orphaned session directories removed per tenant per sweep. A bound, like the batch cap: a tenant
 * restored from a large backup drains over several nights instead of in one long pass.
 */
export const RETENTION_GC_MAX_PER_SWEEP = 500;

/**
 * A session directory written to more recently than this is never collected. An upload creates
 * its bytes before its row is visible to anyone, and the sweep must not delete a file whose row is
 * about to exist.
 */
export const STORAGE_GC_GRACE_MS = 60 * 60 * 1000;

export const STORAGE_GC_ACTION = "privacy.storage_gc";

/** Session ids looked up per query when reconciling storage against rows. */
const GC_LOOKUP_CHUNK = 200;

/** Anything that can run the four deletes and the anonymizing update. */
type SessionDeleteClient = Pick<PrismaClient, "message" | "sessionEvent" | "fact" | "attachment" | "session">;

export interface TenantSweep {
  companyId: string;
  /** Voice recordings deleted this run because they passed `privacy.audioRetentionDays`. */
  audioDeleted: number;
  /** Expired sessions loaded this run. */
  examined: number;
  /** Sessions anonymized this run. */
  deleted: number;
  retentionMonths: number;
  olderThan: string;
  /** The per-run batch cap was reached; the rest is swept by the next run. */
  truncated: boolean;
  /** Stored-file deletions that failed this run (the storage GC retries them next run). */
  bytesFailed: number;
  /** Orphaned session directories the storage GC pass removed this run. */
  orphansCollected: number;
}

export interface RetentionSweepDeps {
  db: PrismaClient;
  settings: SettingsService;
  log: Logger;
  /** Optional so a caller with no uploads configured still sweeps rows; see deleteSessionBytes. */
  storage?: StoragePort;
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
  options: { markEnded?: boolean; storage?: StoragePort; companyId?: string; log?: Logger } = {},
): Promise<{ bytesFailed: number }> {
  await tenantBatch(db, deleteSessionOps(db, [sessionId], options));
  return { bytesFailed: await deleteSessionBytes([sessionId], options) };
}

/**
 * Removes the stored bytes for sessions whose rows have just gone, and answers how many sessions
 * it could not clear.
 *
 * Rows first, bytes second, and a failure here is logged and counted rather than thrown. The
 * alternative is worse in both directions: bytes first would delete a participant's audio and then
 * possibly fail to delete the rows that reference it, and re-throwing would turn "the object store
 * hiccupped" into "the retention sweep stopped", leaving every later tenant unswept.
 *
 * What a failure leaves behind is a directory with no live session behind it. The sweep never
 * revisits a session it has anonymized, so nothing here retries it; the storage GC pass
 * (`collectOrphans`) does, by listing storage rather than rows. The count is returned so a caller
 * can retry sooner (the delete-session job throws on it) and the sweep can report it.
 */
async function deleteSessionBytes(
  sessionIds: string[],
  options: { storage?: StoragePort; companyId?: string; log?: Logger },
): Promise<number> {
  const { storage, companyId, log } = options;
  if (!storage || !companyId) return 0;
  let failed = 0;
  for (const sessionId of sessionIds) {
    try {
      await storage.deletePrefix(sessionPrefix(companyId, sessionId));
    } catch (err) {
      failed++;
      log?.warn("deleted a session's rows but not its stored files", {
        companyId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return failed;
}

/**
 * Storage GC: removes session directories that no live session owns.
 *
 * Stateless and self-healing, which is why it is a pass and not a retry queue. A queue would need
 * a record of what failed, and after the rows are gone nothing remembers the prefix. Listing
 * storage needs no memory: whatever is there and has no live session is garbage, whether it got
 * there through a failed delete, a crash between rows and bytes, an upload whose session was
 * deleted underneath it, or a restore.
 *
 * Scoped to one tenant's own prefix, so tenant A's sweep can never name tenant B's objects.
 */
async function collectOrphans(
  deps: { db: PrismaClient; log: Logger; storage: StoragePort },
  companyId: string,
  now: Date,
): Promise<{ collected: number; failed: number }> {
  const { db, log, storage } = deps;
  let listed;
  try {
    listed = await storage.listPrefixes(companyPrefix(companyId));
  } catch (err) {
    log.warn("storage GC could not list the tenant's files", {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { collected: 0, failed: 1 };
  }
  const settled = listed.filter((p) => now.getTime() - p.modifiedAt.getTime() >= STORAGE_GC_GRACE_MS);
  const live = new Set<string>();
  for (let i = 0; i < settled.length; i += GC_LOOKUP_CHUNK) {
    const ids = settled.slice(i, i + GC_LOOKUP_CHUNK).map((p) => p.name);
    const rows = await db.session.findMany({
      where: { companyId, id: { in: ids }, status: { not: "deleted" } },
      select: { id: true },
    });
    for (const r of rows) live.add(r.id);
  }
  const orphans = settled.filter((p) => !live.has(p.name)).slice(0, RETENTION_GC_MAX_PER_SWEEP);
  let collected = 0;
  let failed = 0;
  for (const orphan of orphans) {
    try {
      await storage.deletePrefix(sessionPrefix(companyId, orphan.name));
      collected++;
    } catch (err) {
      failed++;
      log.warn("storage GC could not remove an orphaned session's files", {
        companyId,
        sessionId: orphan.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { collected, failed };
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
  const { db, settings, log, storage } = deps;
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
        sweepTenant(
          { db, settings, log, ...(storage ? { storage } : {}) },
          company.id,
          now,
          batchSize,
          maxBatches,
        ),
      ),
    );
  }
  return sweeps;
}

async function sweepTenant(
  deps: { db: PrismaClient; settings: SettingsService; log: Logger; storage?: StoragePort },
  companyId: string,
  now: Date,
  batchSize: number,
  maxBatches: number,
): Promise<TenantSweep> {
  const { db, settings, log, storage } = deps;
  const audio = await sweepAudio({ db, settings, log, ...(storage ? { storage } : {}) }, companyId, now);
  const audioDeleted = audio.deleted;
  let bytesFailed = audio.failed;
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
    const ids = expired.map((s) => s.id);
    await tenantBatch(db, deleteSessionOps(db, ids));
    bytesFailed += await deleteSessionBytes(ids, { ...(storage ? { storage } : {}), companyId, log });
    deleted += expired.length;
    if (expired.length < batchSize) break;
    if (batch === maxBatches - 1) truncated = true;
  }

  // After the row batches, so a directory this very sweep failed to clear is retried next run
  // (it is not an orphan until its session has been anonymized, which it just was).
  let orphansCollected = 0;
  if (storage) {
    const gc = await collectOrphans({ db, log, storage }, companyId, now);
    orphansCollected = gc.collected;
    bytesFailed += gc.failed;
    if (gc.collected > 0) {
      await db.auditLog.create({
        data: {
          companyId,
          actorId: null,
          action: STORAGE_GC_ACTION,
          targetType: "company",
          targetId: companyId,
          diff: { orphansCollected: gc.collected } satisfies Prisma.InputJsonValue,
        },
      });
    }
  }

  const result: TenantSweep = {
    companyId,
    examined,
    deleted,
    audioDeleted,
    retentionMonths,
    olderThan: cutoff.toISOString(),
    truncated,
    bytesFailed,
    orphansCollected,
  };
  // Structured, and free of participant identifiers: counts and the policy only.
  log.info("retention sweep", { ...result });
  if (bytesFailed > 0)
    log.warn("retention sweep left stored files behind; the next sweep retries them", {
      companyId,
      bytesFailed,
    });
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

/** Recordings deleted per statement; a bounded sweep must not sit on the table. */
const AUDIO_BATCH_SIZE = 500;

/**
 * Deletes voice recordings past `privacy.audioRetentionDays`, leaving everything else alone.
 *
 * A separate, shorter clock from session retention, and deliberately so. The transcript is the
 * durable record of what someone said about their work and lives as long as the session does; the
 * recording is their actual voice, which is far more identifying and worth much less once it has
 * been transcribed. A tenant that sets zero gets recordings removed on the first sweep after
 * transcription, which is the strongest setting the interface offers and costs them nothing but
 * playback.
 *
 * Only the bytes and the row go. The message the transcript became stays exactly where it is, so
 * the interview reads the same afterwards.
 */
async function sweepAudio(
  deps: { db: PrismaClient; settings: SettingsService; log: Logger; storage?: StoragePort },
  companyId: string,
  now: Date,
): Promise<{ deleted: number; failed: number }> {
  const { db, settings, log, storage } = deps;
  const days = await settings.get("privacy.audioRetentionDays", [{ scope: "tenant", scopeId: companyId }]);
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const expired = await db.attachment.findMany({
    // `ingestedAt` rather than `createdAt`: the clock starts when the recording has been
    // transcribed and is therefore redundant, not when it was uploaded. A recording still waiting
    // on a failed transcription is not yet safe to drop.
    where: { companyId, kind: "audio", ingestedAt: { not: null, lt: cutoff } },
    select: { id: true, storageKey: true },
    take: AUDIO_BATCH_SIZE,
  });
  if (expired.length === 0) return { deleted: 0, failed: 0 };

  // Bytes first, then the row, and only the rows whose bytes are gone. Here the row is the memory
  // of what is stored: leave it when the delete failed and the next sweep selects it again. The
  // other order (row first) would leave a file under a live session that nothing can find.
  // Deleting a key that is not there is not an error, so a crash after the bytes and before the
  // row simply finishes on the next run.
  let failed = 0;
  const removable: string[] = [];
  for (const row of expired) {
    if (storage && row.storageKey.length > 0) {
      try {
        await storage.delete(row.storageKey);
      } catch (err) {
        failed++;
        log.warn("could not delete an expired recording's file; its row stays so the next sweep retries", {
          companyId,
          attachmentId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }
    removable.push(row.id);
  }
  if (removable.length > 0) await db.attachment.deleteMany({ where: { id: { in: removable } } });
  log.info("audio retention sweep", { companyId, deleted: removable.length, failed, days });
  return { deleted: removable.length, failed };
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

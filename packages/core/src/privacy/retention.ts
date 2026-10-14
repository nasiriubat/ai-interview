import { randomBytes } from "node:crypto";
import type { Logger } from "@aidp/ai";
import { tenantTransaction, withSystemTenant, withTenant } from "@aidp/db";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Crypto } from "../crypto.js";
import type { SettingsService } from "../settings/service.js";
import { companyPrefix, sessionPrefix, type StoragePort } from "../storage/index.js";

/**
 * Retention enforcement (spec 11: "retention period per tenant (default 24 months) with automatic
 * deletion jobs"). The consent text promises participants their answers do not live forever, so the
 * promise is kept by a daily sweep rather than by hand.
 *
 * Expired sessions are anonymized, not dropped. What goes is everything that identifies a person or
 * holds what they said: messages, events, facts, attachments, specification versions, the
 * participant row (name, email, role, department, token hash), the invitation address, the
 * email-uniqueness hash and any pending verification code, and the personal JSON columns of the
 * session itself. The session row stays as `status: "deleted"` with empty state and summary
 * (D-81). Campaign participation
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
 * tenant's scope in turn (`withTenant`) and writes through `tenantTransaction`, so row-level security
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

export interface TenantSweep {
  companyId: string;
  /** Voice recordings deleted this run because they passed `privacy.audioRetentionDays`. */
  audioDeleted: number;
  /** Expired sessions loaded this run. */
  examined: number;
  /** Sessions anonymized this run. */
  deleted: number;
  /** Participant rows with no live session removed this run (D-81). */
  residueRemoved: number;
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
  /** The platform key's tagger: without it an anonymous response's hash row is left in place (D-142). */
  crypto?: OwnerTagger;
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
  options: {
    markEnded?: boolean;
    storage?: StoragePort;
    companyId?: string;
    log?: Logger;
    /**
     * Needed to find the address-hash row of an anonymous response, which no participant row
     * points at (D-142). Without it only responses with a pointer (identified, or older rows) are
     * cleared of their hash.
     */
    crypto?: OwnerTagger;
  } = {},
): Promise<{ bytesFailed: number }> {
  await eraseSession(db, sessionId, {
    markEnded: options.markEnded ?? false,
    audit: true,
    ...(options.crypto ? { crypto: options.crypto } : {}),
  });
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

/** What replaces a quote that was removed from a generated report. */
export const REDACTION_MARK = "[removed at participant's request]";

/** Quotes shorter than this are not replaced: a short string would corrupt unrelated text. */
const MIN_REDACTABLE_CHARS = 12;

/**
 * Erases one session and everything that identifies its participant, in one transaction.
 *
 * The session row is locked first (`FOR UPDATE`), so a turn, an extraction or an upload that is
 * mid-flight either finishes before the erase and is removed by it, or is refused after it by the
 * database trigger from migration 0013. There is no window in which content is written for a
 * session that is already gone.
 *
 * Idempotent: a second run finds nothing left to remove. Returns false when the session does not
 * exist.
 */
export async function eraseSession(
  db: PrismaClient,
  sessionId: string,
  options: { markEnded: boolean; audit: boolean; crypto?: OwnerTagger },
): Promise<boolean> {
  return tenantTransaction(
    db,
    async (tx) => {
      const locked = await tx.$queryRaw<
        {
          id: string;
          companyId: string;
          campaignId: string | null;
          participantId: string | null;
          status: string;
        }[]
      >`SELECT "id", "companyId", "campaignId", "participantId", "status" FROM "Session" WHERE "id" = ${sessionId} FOR UPDATE`;
      const session = locked[0];
      if (!session) return false;

      // What the participant said, as it appears outside the session: fact quotes and the evidence
      // snippets built from them. Captured before the facts go so reports can be scrubbed of them.
      const [facts, evidence] = await Promise.all([
        tx.fact.findMany({ where: { sessionId }, select: { payload: true } }),
        tx.opportunityEvidence.findMany({ where: { fact: { sessionId } }, select: { snippet: true } }),
      ]);
      const quotes = new Set<string>();
      for (const f of facts) {
        const quote = (f.payload as { quote?: unknown } | null)?.quote;
        if (typeof quote === "string") quotes.add(quote);
      }
      for (const e of evidence) quotes.add(e.snippet);

      const participant = session.participantId
        ? await tx.participant.findUnique({
            where: { id: session.participantId },
            select: { id: true, fields: true },
          })
        : null;
      const emailHash = hashOf(participant?.fields);

      await tx.message.deleteMany({ where: { sessionId } });
      await tx.sessionEvent.deleteMany({ where: { sessionId } });
      await tx.fact.deleteMany({ where: { sessionId } });
      await tx.attachment.deleteMany({ where: { sessionId } });
      await tx.specVersion.deleteMany({ where: { sessionId } });

      await tx.session.update({
        where: { id: sessionId },
        data: {
          status: "deleted",
          state: {},
          summary: "",
          handoff: Prisma.DbNull,
          title: "",
          specEdits: {},
          invitations: [],
          participantId: null,
          turnLockedAt: null,
          // The flag's reason is model prose about a person; it goes with what it was written from.
          flagged: false,
          flagReason: null,
          flaggedAt: null,
          flagAckedAt: null,
          flagAckedBy: null,
          // The sweep leaves `endedAt` alone: it is what the expiry is measured from.
          ...(options.markEnded ? { endedAt: new Date() } : {}),
        },
      });
      if (participant) await tx.participant.delete({ where: { id: participant.id } });

      await forgetAddress(tx, {
        sessionIds: [sessionId],
        campaignId: session.campaignId,
        emailHash,
        ownerTags:
          options.crypto && session.campaignId && participant
            ? options.crypto.participantTags(session.campaignId, participant.id)
            : [],
      });

      if (session.campaignId) {
        await redactReports(tx, session.campaignId, [...quotes]);
      }

      if (options.audit && session.status !== "deleted") {
        // No participant data: the session id is the only thing recorded, and it is already in the
        // retained session row.
        await tx.auditLog.create({
          data: {
            companyId: session.companyId,
            actorId: null,
            action: "privacy.session_deleted",
            targetType: "session",
            targetId: sessionId,
            diff: {},
          },
        });
      }
      return true;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

/** What erasure needs from the platform key: the tag that finds an anonymous response's hash row. */
export type OwnerTagger = Pick<Crypto, "participantTags">;

/** The uniqueness pointer a participant row carries (`_emailHash`), if it has one. */
function hashOf(fields: unknown): string | null {
  const value = (fields as { _emailHash?: unknown } | null | undefined)?._emailHash;
  return typeof value === "string" && value.length > 0 ? value : null;
}

type Tx = Parameters<Parameters<typeof tenantTransaction>[1]>[0];

/**
 * Removes every trace of an email address from a campaign's own tables.
 *
 * The invitation row is kept (send counts, status history) but loses the address, the link and
 * the hash that would match a re-invitation. The uniqueness hash and any pending code are
 * deleted: a retained HMAC of an address is still personal data for whoever holds the key, so
 * erasure outranks the "one response per person" guarantee (D-81). The consequence is stated in
 * the privacy notice: an open email-code link accepts the same person again.
 */
async function forgetAddress(
  tx: Tx,
  target: {
    sessionIds: string[];
    campaignId: string | null;
    emailHash: string | null;
    /**
     * The keyed tag of an anonymous response, under every key in the ring, which is how its hash
     * row is found (D-142, D-164): a row written before a key rotation carries the old key's tag.
     */
    ownerTags?: string[];
  },
): Promise<void> {
  const { sessionIds, campaignId } = target;
  // Every value this person's address is stored as in the campaign: the pointer on the participant
  // row where there is one, and the hash row the owner tag names where there is not.
  const hashes = new Set<string>();
  if (target.emailHash) hashes.add(target.emailHash);
  if (campaignId && target.ownerTags && target.ownerTags.length > 0) {
    const tagged = await tx.campaignEmailHash.findMany({
      where: { campaignId, ownerTag: { in: target.ownerTags } },
      select: { emailHash: true },
    });
    for (const row of tagged) hashes.add(row.emailHash);
  }
  const hashList = [...hashes];
  const invitations = await tx.invitation.findMany({
    where: {
      OR: [
        { sessionId: { in: sessionIds } },
        ...(campaignId && hashList.length ? [{ campaignId, emailHash: { in: hashList } }] : []),
      ],
    },
    select: { id: true, sentAt: true },
  });
  for (const inv of invitations) {
    await tx.invitation.update({
      where: { id: inv.id },
      data: {
        email: null,
        emailHash: `deleted:${randomBytes(12).toString("hex")}`,
        tokenHash: `deleted:${randomBytes(24).toString("hex")}`,
        status: "revoked",
        sessionId: null,
        openedAt: null,
        // Day resolution is enough for a send count and no longer pairs with a session's timing.
        sentAt: inv.sentAt
          ? new Date(Date.UTC(inv.sentAt.getUTCFullYear(), inv.sentAt.getUTCMonth(), inv.sentAt.getUTCDate()))
          : null,
      },
    });
  }
  if (campaignId && hashList.length) {
    await tx.campaignEmailHash.deleteMany({ where: { campaignId, emailHash: { in: hashList } } });
    await tx.emailCode.deleteMany({ where: { campaignId, emailHash: { in: hashList } } });
  }
}

/**
 * Replaces verbatim quotes in a campaign's generated reports and opportunities.
 *
 * Aggregates (cluster counts, scores) are untouched, as spec 11 says they remain. The report text
 * is the one place a participant's own words survive outside their session, so an exact match of
 * what was quoted is replaced with a fixed marker, and the analysis is flagged stale so an admin
 * knows to rerun it. An exact-match replace will not catch a quote that was paraphrased or
 * reflowed; that residue is why the flag exists and why the privacy notice does not promise more
 * than "answers, recordings and files".
 */
async function redactReports(tx: Tx, campaignId: string, quotes: string[]): Promise<void> {
  const redactable = quotes.filter((q) => q.length >= MIN_REDACTABLE_CHARS);
  for (const quote of redactable) {
    // The same text inside a JSON document is escaped; match that spelling as well.
    const escaped = JSON.stringify(quote).slice(1, -1);
    await tx.$executeRaw`
      UPDATE "Report"
         SET "markdown" = replace("markdown", ${quote}::text, ${REDACTION_MARK}::text),
             "sections" = replace("sections"::text, ${escaped}::text, ${REDACTION_MARK}::text)::jsonb
       WHERE "analysisId" IN (SELECT "id" FROM "Analysis" WHERE "campaignId" = ${campaignId})
         AND (position(${quote}::text in "markdown") > 0 OR position(${escaped}::text in "sections"::text) > 0)`;
    await tx.$executeRaw`
      UPDATE "Opportunity"
         SET "summary" = replace("summary", ${quote}::text, ${REDACTION_MARK}::text),
             "rationale" = replace("rationale", ${quote}::text, ${REDACTION_MARK}::text),
             "whyNotAi" = replace("whyNotAi", ${quote}::text, ${REDACTION_MARK}::text),
             "factors" = replace("factors"::text, ${escaped}::text, ${REDACTION_MARK}::text)::jsonb
       WHERE "analysisId" IN (SELECT "id" FROM "Analysis" WHERE "campaignId" = ${campaignId})
         AND (position(${quote}::text in "summary") > 0
              OR position(${quote}::text in "rationale") > 0
              OR position(${quote}::text in coalesce("whyNotAi", '')) > 0
              OR position(${escaped}::text in "factors"::text) > 0)`;
  }
  // Flag every analysis of the campaign, not only those a quote was found in: each was computed
  // from data that has since changed.
  await tx.$executeRaw`
    UPDATE "Analysis"
       SET "stats" = COALESCE("stats", '{}'::jsonb) || '{"stale": true}'::jsonb
     WHERE "campaignId" = ${campaignId}`;
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

  // The only cross-tenant read in the sweep: which tenants exist. Everything after it runs fenced
  // into one tenant. The Company policy shows a tenant context nobody but itself (D-141), so the
  // listing steps into the system context and back out.
  const companies = await withSystemTenant(() =>
    db.company.findMany({ select: { id: true }, orderBy: { id: "asc" } }),
  );
  const sweeps: TenantSweep[] = [];
  for (const company of companies) {
    // One tenant at a time, inside that tenant's scope: the job spans companies, its statements
    // never do, so row-level security stays engaged for every delete it makes.
    sweeps.push(
      await withTenant(company.id, () =>
        sweepTenant(
          {
            db,
            settings,
            log,
            ...(storage ? { storage } : {}),
            ...(deps.crypto ? { crypto: deps.crypto } : {}),
          },
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
  deps: {
    db: PrismaClient;
    settings: SettingsService;
    log: Logger;
    storage?: StoragePort;
    crypto?: OwnerTagger;
  },
  companyId: string,
  now: Date,
  batchSize: number,
  maxBatches: number,
): Promise<TenantSweep> {
  const { db, settings, log, storage, crypto } = deps;
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
    // One transaction per session, never one per sweep: a long transaction on a big table blocks
    // vacuum and holds locks for the whole run, and an erase takes a row lock on its session.
    const ids = expired.map((s) => s.id);
    for (const id of ids)
      await eraseSession(db, id, { markEnded: false, audit: false, ...(crypto ? { crypto } : {}) });
    bytesFailed += await deleteSessionBytes(ids, { ...(storage ? { storage } : {}), companyId, log });
    deleted += expired.length;
    if (expired.length < batchSize) break;
    if (batch === maxBatches - 1) truncated = true;
  }

  const residueRemoved = await sweepResidue(db, companyId, now, maxBatches, crypto);
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
    residueRemoved,
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
  if (deleted > 0 || residueRemoved > 0) {
    await db.auditLog.create({
      data: {
        companyId,
        actorId: null,
        action: RETENTION_SWEEP_ACTION,
        targetType: "company",
        targetId: companyId,
        diff: {
          deleted,
          residueRemoved,
          retentionMonths,
          olderThan: result.olderThan,
        } satisfies Prisma.InputJsonValue,
      },
    });
  }
  return result;
}

/** A participant row this old with no live session is residue, not a person mid-interview. */
const RESIDUE_GRACE_DAYS = 7;

/**
 * Removes participant rows that no live session needs: those left by deletions made before the
 * participant was erased with the session, and those a failed session create orphaned. Their
 * address hash, pending codes and invitation address go with them, by the same rules as an erase.
 * A tenant's requirements invitee with an open session is untouched: it has a live session.
 */
async function sweepResidue(
  db: PrismaClient,
  companyId: string,
  now: Date,
  maxBatches: number,
  crypto?: OwnerTagger,
): Promise<number> {
  const cutoff = new Date(now.getTime() - RESIDUE_GRACE_DAYS * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const n = await tenantTransaction(db, async (tx) => {
      const candidates = await tx.participant.findMany({
        where: { companyId, createdAt: { lt: cutoff }, sessions: { none: { status: { not: "deleted" } } } },
        select: { id: true, campaignId: true, fields: true, sessions: { select: { id: true } } },
        orderBy: { createdAt: "asc" },
        take: RETENTION_BATCH_SIZE,
      });
      for (const p of candidates) {
        await forgetAddress(tx, {
          sessionIds: p.sessions.map((x) => x.id),
          campaignId: p.campaignId,
          emailHash: hashOf(p.fields),
          ownerTags: crypto && p.campaignId ? crypto.participantTags(p.campaignId, p.id) : [],
        });
        await tx.participant.delete({ where: { id: p.id } });
      }
      return candidates.length;
    });
    removed += n;
    if (n < RETENTION_BATCH_SIZE) break;
  }
  return removed;
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

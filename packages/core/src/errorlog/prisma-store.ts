import { tenantTransaction, withSystemTenant } from "@aidp/db";
import type { PrismaClient } from "@prisma/client";
import { groupKeyOf } from "./sanitize.js";
import type { ErrorStore, ErrorWrite } from "./types.js";

/** Occurrences kept per group: the newest; older ones go as each new one is stored (D-477). */
export const ERROR_OCCURRENCES_PER_GROUP = 20;
/** The whole log's ceiling on occurrences, enforced by the daily sweep. */
export const ERROR_OCCURRENCES_MAX = 20_000;
/** And on groups, for a storm of distinct faults. */
export const ERROR_GROUPS_MAX = 5_000;
/** Hourly counters older than this are trimmed; "the last 7 days" needs seven and a margin. */
export const ERROR_HOURLY_KEEP_DAYS = 8;

/** `2026-10-21T13`: the UTC hour an occurrence is counted in. */
export const hourKey = (at: Date): string => at.toISOString().slice(0, 13);

/** A JS instant as the `timestamp(3)` (UTC, no zone) Prisma stores. */
const UTC = (n: number): string => `($${n}::timestamptz AT TIME ZONE 'UTC')`;

const UPSERT_GROUP = `
INSERT INTO "ErrorGroup" ("id", "groupKey", "fingerprint", "companyId", "source", "severity", "name",
                          "message", "route", "jobName", "count", "hourly", "firstSeenAt", "lastSeenAt")
VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::int,
        jsonb_build_object($11::text, $10::int), ${UTC(12)}, ${UTC(12)})
ON CONFLICT ("groupKey") DO UPDATE SET
  "count" = "ErrorGroup"."count" + EXCLUDED."count",
  "hourly" = jsonb_set("ErrorGroup"."hourly", ARRAY[$11::text],
               to_jsonb(COALESCE(("ErrorGroup"."hourly" ->> $11::text)::int, 0) + EXCLUDED."count")),
  "lastSeenAt" = GREATEST("ErrorGroup"."lastSeenAt", EXCLUDED."lastSeenAt"),
  "severity" = EXCLUDED."severity",
  "name" = EXCLUDED."name",
  "message" = EXCLUDED."message",
  "route" = EXCLUDED."route",
  "resolvedAt" = NULL,
  "resolvedById" = NULL
RETURNING "id"`;

const PRUNE_GROUP = `
DELETE FROM "ErrorOccurrence"
 WHERE "groupId" = $1
   AND "id" NOT IN (SELECT "id" FROM "ErrorOccurrence" WHERE "groupId" = $1
                     ORDER BY "occurredAt" DESC, "id" DESC LIMIT $2)`;

/**
 * The error log in Postgres (D-477). Every statement runs as the system tenant: a fault is
 * recorded from whichever tenant's request it happened in, and only the platform operator reads
 * it back. The group row is an atomic upsert (count, hourly counter, last seen, reopened), so the
 * API and the worker writing the same fault at once neither lose a count nor collide.
 */
export class PrismaErrorStore implements ErrorStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly keepPerGroup = ERROR_OCCURRENCES_PER_GROUP,
  ) {}

  async write(batch: ErrorWrite[]): Promise<void> {
    if (batch.length === 0) return;
    await withSystemTenant(async () => {
      // A tenant id that names no company (an operator's stray X-Company-Id, a tenant offboarded a
      // moment ago) would fail the foreign key and lose the whole write; it is recorded as the
      // platform's instead.
      const named = [...new Set(batch.map((w) => w.record.companyId).filter((c): c is string => c !== null))];
      const known = new Set(
        named.length
          ? (await this.db.company.findMany({ where: { id: { in: named } }, select: { id: true } })).map(
              (c) => c.id,
            )
          : [],
      );
      for (const w of batch) {
        const companyId =
          w.record.companyId !== null && known.has(w.record.companyId) ? w.record.companyId : null;
        const record =
          companyId === w.record.companyId
            ? w.record
            : { ...w.record, companyId, groupKey: groupKeyOf(w.record.fingerprint, companyId) };
        await this.writeOne({ ...w, record });
      }
    });
  }

  private async writeOne(w: ErrorWrite): Promise<void> {
    const r = w.record;
    await tenantTransaction(this.db, async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        UPSERT_GROUP,
        r.groupKey,
        r.fingerprint,
        r.companyId,
        r.source,
        r.severity,
        r.name,
        r.message,
        r.route,
        r.jobName,
        w.count,
        hourKey(r.occurredAt),
        r.occurredAt.toISOString(),
      );
      const groupId = rows[0]?.id;
      if (!groupId || !w.storeOccurrence) return;
      await tx.errorOccurrence.create({
        data: {
          groupId,
          companyId: r.companyId,
          occurredAt: r.occurredAt,
          source: r.source,
          severity: r.severity,
          name: r.name,
          message: r.message,
          stack: r.stack,
          route: r.route,
          path: r.path,
          method: r.method,
          status: r.status,
          requestId: r.requestId,
          userId: r.userId,
          sessionId: r.sessionId,
          release: r.release,
          userAgent: r.userAgent,
          jobName: r.jobName,
          jobAttempt: r.jobAttempt,
          jobFinal: r.jobFinal,
        },
      });
      await tx.$executeRawUnsafe(PRUNE_GROUP, groupId, this.keepPerGroup);
    });
  }
}

export interface ErrorSweepResult {
  groups: number;
  occurrences: number;
  /** Occurrences removed by the global ceiling rather than by age. */
  capped: number;
}

/**
 * The daily clean-up (`ops.error-log-sweep`, D-477): groups not seen for `retentionDays` go with
 * their occurrences, occurrences older than that go on their own, and the ceilings on the whole
 * log are enforced oldest first. Hourly counters older than eight days are trimmed.
 */
export async function sweepErrorLog(
  db: PrismaClient,
  options: { retentionDays: number; maxOccurrences?: number; maxGroups?: number; now?: Date },
): Promise<ErrorSweepResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.retentionDays * 86_400_000);
  const maxOccurrences = options.maxOccurrences ?? ERROR_OCCURRENCES_MAX;
  const maxGroups = options.maxGroups ?? ERROR_GROUPS_MAX;
  return withSystemTenant(async () => {
    const groups = await db.errorGroup.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
    const old = await db.errorOccurrence.deleteMany({ where: { occurredAt: { lt: cutoff } } });
    const overGroups = await db.$executeRawUnsafe(
      `DELETE FROM "ErrorGroup" WHERE "id" IN (
         SELECT "id" FROM "ErrorGroup" ORDER BY "lastSeenAt" DESC, "id" DESC OFFSET $1)`,
      maxGroups,
    );
    const capped = await db.$executeRawUnsafe(
      `DELETE FROM "ErrorOccurrence" WHERE "id" IN (
         SELECT "id" FROM "ErrorOccurrence" ORDER BY "occurredAt" DESC, "id" DESC OFFSET $1)`,
      maxOccurrences,
    );
    const keepFrom = hourKey(new Date(now.getTime() - ERROR_HOURLY_KEEP_DAYS * 86_400_000));
    await db.$executeRawUnsafe(
      `UPDATE "ErrorGroup" g
          SET "hourly" = COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(g."hourly") WHERE key >= $1), '{}'::jsonb)
        WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(g."hourly") k WHERE k < $1)`,
      keepFrom,
    );
    return { groups: groups.count + overGroups, occurrences: old.count, capped };
  });
}

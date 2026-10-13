import { withSystemTenant } from "@aidp/db";
import { Prisma, type PrismaClient } from "@prisma/client";
import { SEVERITY_RANK, type AlertContext, type Severity } from "./port.js";

/** What the router tells the store about one occurrence. */
export interface OccurrenceInput {
  key: string;
  kind: string;
  severity: Severity;
  companyId?: string | undefined;
  title: string;
  message: string;
  context: AlertContext;
  now: Date;
  /** The window in which a repeat of the same key is counted and not sent again. */
  repeatMs: number;
}

export interface Occurrence {
  /** True when this occurrence owns a notification: new, reopened, past the window, or escalated. */
  notify: boolean;
  count: number;
  /** For a duplicate: whether the earlier notification is still standing as delivered. */
  alreadyDelivered: boolean;
}

/** The dedupe, rate-limit and history store behind `AlertRouter`. One contract, two adapters. */
export interface AlertState {
  record(input: OccurrenceInput): Promise<Occurrence>;
  /** Every channel failed: give the claim back so the next occurrence retries at once. */
  release(key: string): Promise<void>;
  /** The condition cleared. The next occurrence of the key notifies again. */
  resolve(key: string, now: Date): Promise<boolean>;
  /** Counts one notification into an hourly bucket and returns the bucket's new total. */
  bump(bucket: string, now: Date): Promise<number>;
  /** The kinds that raised most since `since`, busiest first, for the storm notice. */
  topKinds(since: Date, limit: number): Promise<{ kind: string; count: number }[]>;
}

/** The kind written on the rows that only count notifications; they are not alerts. */
export const RATE_KIND = "_rate";

const lowerThan = (severity: Severity): Severity[] =>
  (Object.keys(SEVERITY_RANK) as Severity[]).filter((s) => SEVERITY_RANK[s] < SEVERITY_RANK[severity]);

interface MemoryRow {
  key: string;
  kind: string;
  severity: Severity;
  count: number;
  lastAt: Date;
  notifiedAt: Date | null;
  resolvedAt: Date | null;
}

/** In-process store: tests, and tools that alert without a database. Same rules as the Prisma one. */
export class MemoryAlertState implements AlertState {
  readonly rows = new Map<string, MemoryRow>();

  async record(i: OccurrenceInput): Promise<Occurrence> {
    const row = this.rows.get(i.key);
    if (!row) {
      this.rows.set(i.key, {
        key: i.key,
        kind: i.kind,
        severity: i.severity,
        count: 1,
        lastAt: i.now,
        notifiedAt: i.now,
        resolvedAt: null,
      });
      return { notify: true, count: 1, alreadyDelivered: false };
    }
    const escalated = SEVERITY_RANK[i.severity] > SEVERITY_RANK[row.severity];
    row.lastAt = i.now;
    if (row.resolvedAt !== null) {
      Object.assign(row, { severity: i.severity, count: 1, notifiedAt: i.now, resolvedAt: null });
      return { notify: true, count: 1, alreadyDelivered: false };
    }
    row.count += 1;
    const stale = row.notifiedAt === null || row.notifiedAt.getTime() < i.now.getTime() - i.repeatMs;
    if (stale || escalated) {
      row.severity = i.severity;
      row.notifiedAt = i.now;
      return { notify: true, count: row.count, alreadyDelivered: false };
    }
    return { notify: false, count: row.count, alreadyDelivered: row.notifiedAt !== null };
  }

  async release(key: string): Promise<void> {
    const row = this.rows.get(key);
    if (row) row.notifiedAt = null;
  }

  async resolve(key: string, now: Date): Promise<boolean> {
    const row = this.rows.get(key);
    if (row?.resolvedAt !== null) return false;
    row.resolvedAt = now;
    return true;
  }

  async bump(bucket: string, now: Date): Promise<number> {
    const key = `rate:${bucket}`;
    const row = this.rows.get(key);
    if (!row) {
      this.rows.set(key, {
        key,
        kind: RATE_KIND,
        severity: "info",
        count: 1,
        lastAt: now,
        notifiedAt: null,
        resolvedAt: null,
      });
      return 1;
    }
    row.count += 1;
    row.lastAt = now;
    return row.count;
  }

  async topKinds(since: Date, limit: number): Promise<{ kind: string; count: number }[]> {
    const totals = new Map<string, number>();
    for (const r of this.rows.values()) {
      if (r.kind === RATE_KIND || r.lastAt < since) continue;
      totals.set(r.kind, (totals.get(r.kind) ?? 0) + r.count);
    }
    return [...totals.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * The `OpsAlert` table. Every statement runs in the system context: the key is global across
 * tenants and a platform row (companyId null) is writable only there (migration 0014).
 *
 * The claim on a notification is one conditional UPDATE, so two processes raising the same key at
 * once (the API and the worker both see an exhausted budget) agree on a single winner without a
 * lock.
 */
export class PrismaAlertState implements AlertState {
  constructor(private readonly db: PrismaClient) {}

  record(i: OccurrenceInput): Promise<Occurrence> {
    return withSystemTenant(async () => {
      const body = {
        kind: i.kind,
        severity: i.severity,
        companyId: i.companyId ?? null,
        title: i.title,
        message: i.message,
        context: i.context as Prisma.InputJsonValue,
      };
      const existing = await this.db.opsAlert.findUnique({ where: { key: i.key } });
      if (!existing) {
        try {
          await this.db.opsAlert.create({
            data: { key: i.key, ...body, count: 1, firstAt: i.now, lastAt: i.now, notifiedAt: i.now },
          });
          return { notify: true, count: 1, alreadyDelivered: false };
        } catch (err) {
          // Another process created it between the read and the insert; it owns the notification.
          if (!isUniqueViolation(err)) throw err;
          return this.countDuplicate(i);
        }
      }

      if (existing.resolvedAt !== null) {
        const reopened = await this.db.opsAlert.updateMany({
          where: { key: i.key, resolvedAt: { not: null } },
          data: { ...body, count: 1, firstAt: i.now, lastAt: i.now, notifiedAt: i.now, resolvedAt: null },
        });
        if (reopened.count > 0) return { notify: true, count: 1, alreadyDelivered: false };
      }

      const threshold = new Date(i.now.getTime() - i.repeatMs);
      const claimed = await this.db.opsAlert.updateMany({
        where: {
          key: i.key,
          resolvedAt: null,
          OR: [
            { notifiedAt: null },
            { notifiedAt: { lt: threshold } },
            { severity: { in: lowerThan(i.severity) } },
          ],
        },
        data: { ...body, lastAt: i.now, notifiedAt: i.now, count: { increment: 1 } },
      });
      if (claimed.count > 0) {
        const row = await this.db.opsAlert.findUnique({ where: { key: i.key } });
        return { notify: true, count: row?.count ?? existing.count + 1, alreadyDelivered: false };
      }
      return this.countDuplicate(i);
    });
  }

  private async countDuplicate(i: OccurrenceInput): Promise<Occurrence> {
    await this.db.opsAlert.updateMany({
      where: { key: i.key },
      data: { title: i.title, message: i.message, lastAt: i.now, count: { increment: 1 } },
    });
    const row = await this.db.opsAlert.findUnique({ where: { key: i.key } });
    return { notify: false, count: row?.count ?? 1, alreadyDelivered: row?.notifiedAt != null };
  }

  release(key: string): Promise<void> {
    return withSystemTenant(async () => {
      await this.db.opsAlert.updateMany({ where: { key }, data: { notifiedAt: null } });
    });
  }

  resolve(key: string, now: Date): Promise<boolean> {
    return withSystemTenant(async () => {
      const r = await this.db.opsAlert.updateMany({
        where: { key, resolvedAt: null },
        data: { resolvedAt: now },
      });
      return r.count > 0;
    });
  }

  bump(bucket: string, now: Date): Promise<number> {
    return withSystemTenant(async () => {
      const key = `rate:${bucket}`;
      const row = await this.db.opsAlert.upsert({
        where: { key },
        create: {
          key,
          kind: RATE_KIND,
          severity: "info",
          title: bucket,
          count: 1,
          firstAt: now,
          lastAt: now,
        },
        update: { count: { increment: 1 }, lastAt: now },
      });
      // A new bucket is the cheap moment to drop the ones nobody will read again.
      if (row.count === 1) {
        await this.db.opsAlert.deleteMany({
          where: { kind: RATE_KIND, lastAt: { lt: new Date(now.getTime() - 48 * 3_600_000) } },
        });
      }
      return row.count;
    });
  }

  topKinds(since: Date, limit: number): Promise<{ kind: string; count: number }[]> {
    return withSystemTenant(async () => {
      const groups = await this.db.opsAlert.groupBy({
        by: ["kind"],
        where: { kind: { not: RATE_KIND }, lastAt: { gte: since } },
        _sum: { count: true },
        orderBy: { _sum: { count: "desc" } },
        take: limit,
      });
      return groups.map((g) => ({ kind: g.kind, count: g._sum.count ?? 0 }));
    });
  }
}

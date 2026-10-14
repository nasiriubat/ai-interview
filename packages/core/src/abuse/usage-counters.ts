import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Fixed-window counters for abuse limits (D-261).
 *
 * The per-address and per-IP buckets in the HTTP layer are in memory and per process: they stop a
 * flood, not a patient attacker, and they cannot say "this campaign has taken 120 new interviews
 * this hour". These counters live in Postgres, so the count is shared by every API replica and
 * survives a restart, and they need no new service (there is no Redis on the one-VPS deployment).
 *
 * A subject is a short string that names *what* is being counted (`session:campaign:<id>`), never
 * a person: a client address enters only as a keyed hash (`Crypto.abuseSubject`). The windows are
 * fixed, aligned to the epoch, so a burst across a boundary can briefly reach twice the limit;
 * that is the price of one indexed upsert per hit and no per-request history.
 */
export interface UsageCounters {
  /** Adds one to the subject's counter in the current window and returns the count including this hit. */
  hit(companyId: string, subject: string, windowMs: number): Promise<number>;
  /** The number of distinct subjects under a prefix that were hit in the current window. */
  distinct(companyId: string, prefix: string, windowMs: number): Promise<number>;
  /** Deletes windows that ended before `before`; returns how many rows went. */
  prune(companyId: string, before: Date): Promise<number>;
}

export const HOUR_MS = 60 * 60_000;

/** The start of the window that contains `at`. */
export function windowStartOf(at: number, windowMs: number): Date {
  return new Date(Math.floor(at / windowMs) * windowMs);
}

export class PrismaUsageCounters implements UsageCounters {
  constructor(
    private readonly db: Pick<PrismaClient, "usageCounter">,
    private readonly now: () => number = Date.now,
  ) {}

  async hit(companyId: string, subject: string, windowMs: number): Promise<number> {
    const windowStart = windowStartOf(this.now(), windowMs);
    const where = { companyId_key_windowStart: { companyId, key: subject, windowStart } };
    // Two requests creating the first row at once: one loses the unique constraint and retries
    // as an increment, so no hit is dropped.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const row = await this.db.usageCounter.upsert({
          where,
          create: { companyId, key: subject, windowStart, count: 1 },
          update: { count: { increment: 1 } },
          select: { count: true },
        });
        return row.count;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      }
    }
    const row = await this.db.usageCounter.update({
      where,
      data: { count: { increment: 1 } },
      select: { count: true },
    });
    return row.count;
  }

  async distinct(companyId: string, prefix: string, windowMs: number): Promise<number> {
    return this.db.usageCounter.count({
      where: {
        companyId,
        windowStart: windowStartOf(this.now(), windowMs),
        key: { startsWith: prefix },
      },
    });
  }

  async prune(companyId: string, before: Date): Promise<number> {
    const { count } = await this.db.usageCounter.deleteMany({
      where: { companyId, windowStart: { lt: before } },
    });
    return count;
  }
}

/** For tests and tools that need the port without a database. */
export class MemoryUsageCounters implements UsageCounters {
  private readonly rows = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  private key(companyId: string, subject: string, windowMs: number): string {
    return `${companyId}\u0000${windowStartOf(this.now(), windowMs).getTime()}\u0000${subject}`;
  }

  async hit(companyId: string, subject: string, windowMs: number): Promise<number> {
    const k = this.key(companyId, subject, windowMs);
    const n = (this.rows.get(k) ?? 0) + 1;
    this.rows.set(k, n);
    return n;
  }

  async distinct(companyId: string, prefix: string, windowMs: number): Promise<number> {
    const head = this.key(companyId, prefix, windowMs);
    return [...this.rows.keys()].filter((k) => k.startsWith(head)).length;
  }

  async prune(): Promise<number> {
    return 0;
  }
}

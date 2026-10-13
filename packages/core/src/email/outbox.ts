import type { PrismaClient } from "@prisma/client";
import type { EmailMessage, EmailPort } from "./port.js";

/**
 * Send-once for email jobs (D-105).
 *
 * An SMTP send followed by a failed job acknowledgement means the queue retries and the message
 * goes out again, up to six times. The handler therefore claims an idempotency key before it
 * sends and marks it sent afterwards; a retry of a message that went out does nothing.
 *
 * A claim has a lease. A process that dies between the claim and the send leaves a row in
 * `sending` that nobody will finish, and a retry within the lease waits (it throws, and the queue
 * tries again with backoff); a retry after the lease takes the claim over and sends. The honest
 * guarantee is at-least-once with duplicates bounded to that crash window, which is the best SMTP
 * allows: there is no way to ask a mail server whether a message already left.
 */

/** How long a `sending` claim is honoured before another attempt may take it over. */
export const EMAIL_CLAIM_LEASE_MS = 10 * 60 * 1000;

/** Sent rows are kept this long so late duplicates are still recognised, then pruned daily. */
export const EMAIL_OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ClaimResult = "claimed" | "already_sent" | "in_flight";

export interface EmailOutbox {
  claim(key: string, companyId: string | undefined, now: Date, leaseMs: number): Promise<ClaimResult>;
  markSent(key: string, at: Date): Promise<void>;
  /** Drops a claim whose send failed, so the retry can send. Leaves a sent row alone. */
  release(key: string): Promise<void>;
  /** Removes sent rows older than the cutoff; answers how many. */
  prune(olderThan: Date): Promise<number>;
}

/** Thrown when another attempt holds the claim; the queue retries it later. */
export class EmailInFlightError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`An attempt to send ${idempotencyKey} is already in progress`);
    this.name = "EmailInFlightError";
  }
}

export interface SendOnceOptions {
  companyId?: string;
  now?: () => Date;
  leaseMs?: number;
}

/** Sends `message` at most once per key (within the crash-window caveat above). */
export async function sendOnce(
  outbox: EmailOutbox,
  email: EmailPort,
  key: string,
  message: EmailMessage,
  options: SendOnceOptions = {},
): Promise<"sent" | "skipped"> {
  const now = options.now ?? (() => new Date());
  const claim = await outbox.claim(key, options.companyId, now(), options.leaseMs ?? EMAIL_CLAIM_LEASE_MS);
  if (claim === "already_sent") return "skipped";
  if (claim === "in_flight") throw new EmailInFlightError(key);
  try {
    await email.send(message);
  } catch (err) {
    await outbox.release(key);
    throw err;
  }
  await outbox.markSent(key, now());
  return "sent";
}

export class PrismaEmailOutbox implements EmailOutbox {
  constructor(private readonly db: PrismaClient) {}

  async claim(key: string, companyId: string | undefined, now: Date, leaseMs: number): Promise<ClaimResult> {
    // The unique key is the arbiter: of any number of concurrent attempts exactly one inserts.
    const created = await this.db.sentEmail.createMany({
      data: [{ idempotencyKey: key, companyId: companyId ?? null, state: "sending", claimedAt: now }],
      skipDuplicates: true,
    });
    if (created.count === 1) return "claimed";

    // Someone has the key. Take it over only if their claim has outlived the lease.
    const takenOver = await this.db.sentEmail.updateMany({
      where: {
        idempotencyKey: key,
        state: "sending",
        claimedAt: { lt: new Date(now.getTime() - leaseMs) },
      },
      data: { claimedAt: now },
    });
    if (takenOver.count === 1) return "claimed";

    const row = await this.db.sentEmail.findUnique({ where: { idempotencyKey: key } });
    return row?.state === "sent" ? "already_sent" : "in_flight";
  }

  async markSent(key: string, at: Date): Promise<void> {
    await this.db.sentEmail.updateMany({
      where: { idempotencyKey: key },
      data: { state: "sent", sentAt: at },
    });
  }

  async release(key: string): Promise<void> {
    await this.db.sentEmail.deleteMany({ where: { idempotencyKey: key, state: "sending" } });
  }

  async prune(olderThan: Date): Promise<number> {
    const { count } = await this.db.sentEmail.deleteMany({
      where: { state: "sent", sentAt: { lt: olderThan } },
    });
    return count;
  }
}

/** In memory, for tests that exercise handlers without a database. */
export class MemoryEmailOutbox implements EmailOutbox {
  readonly rows = new Map<string, { state: "sending" | "sent"; claimedAt: Date; sentAt?: Date }>();

  async claim(key: string, _companyId: string | undefined, now: Date, leaseMs: number): Promise<ClaimResult> {
    const row = this.rows.get(key);
    if (!row) {
      this.rows.set(key, { state: "sending", claimedAt: now });
      return "claimed";
    }
    if (row.state === "sent") return "already_sent";
    if (row.claimedAt.getTime() < now.getTime() - leaseMs) {
      row.claimedAt = now;
      return "claimed";
    }
    return "in_flight";
  }

  async markSent(key: string, at: Date): Promise<void> {
    const row = this.rows.get(key);
    if (row) {
      row.state = "sent";
      row.sentAt = at;
    }
  }

  async release(key: string): Promise<void> {
    if (this.rows.get(key)?.state === "sending") this.rows.delete(key);
  }

  async prune(olderThan: Date): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.state === "sent" && row.sentAt && row.sentAt < olderThan) {
        this.rows.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

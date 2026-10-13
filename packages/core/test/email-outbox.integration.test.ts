import { describeDb } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EMAIL_CLAIM_LEASE_MS, PrismaEmailOutbox, sendOnce } from "../src/email/outbox.js";
import { MemoryEmail } from "../src/email/port.js";

/** The Postgres half of send-once (D-105): the unique key, not application code, picks the winner. */
describeDb("PrismaEmailOutbox", () => {
  const db = new PrismaClient();
  const outbox = new PrismaEmailOutbox(db);
  const run = `ob_${Date.now().toString(36)}`;
  const key = (n: string) => `${run}:${n}`;

  afterAll(async () => {
    await db.sentEmail.deleteMany({ where: { idempotencyKey: { startsWith: run } } });
    await db.$disconnect();
  });
  beforeAll(async () => {
    await db.sentEmail.deleteMany({ where: { idempotencyKey: { startsWith: run } } });
  });

  it("of many concurrent attempts exactly one claims", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => outbox.claim(key("race"), undefined, new Date(), EMAIL_CLAIM_LEASE_MS)),
    );

    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "in_flight")).toHaveLength(5);
  });

  it("recognises a sent message, and lets a failed send be retried", async () => {
    const now = new Date();
    await outbox.claim(key("sent"), undefined, now, EMAIL_CLAIM_LEASE_MS);
    await outbox.markSent(key("sent"), now);
    expect(await outbox.claim(key("sent"), undefined, now, EMAIL_CLAIM_LEASE_MS)).toBe("already_sent");

    await outbox.claim(key("failed"), undefined, now, EMAIL_CLAIM_LEASE_MS);
    await outbox.release(key("failed"));
    expect(await outbox.claim(key("failed"), undefined, now, EMAIL_CLAIM_LEASE_MS)).toBe("claimed");

    // A release never removes a message that was sent.
    await outbox.release(key("sent"));
    expect(await outbox.claim(key("sent"), undefined, now, EMAIL_CLAIM_LEASE_MS)).toBe("already_sent");
  });

  it("takes over a claim only once its lease has passed, and then only one taker wins", async () => {
    const start = new Date();
    await outbox.claim(key("crash"), undefined, start, EMAIL_CLAIM_LEASE_MS);

    const within = new Date(start.getTime() + EMAIL_CLAIM_LEASE_MS - 1000);
    expect(await outbox.claim(key("crash"), undefined, within, EMAIL_CLAIM_LEASE_MS)).toBe("in_flight");

    const after = new Date(start.getTime() + EMAIL_CLAIM_LEASE_MS + 1000);
    const takers = await Promise.all([
      outbox.claim(key("crash"), undefined, after, EMAIL_CLAIM_LEASE_MS),
      outbox.claim(key("crash"), undefined, after, EMAIL_CLAIM_LEASE_MS),
    ]);
    expect(takers.filter((r) => r === "claimed")).toHaveLength(1);
  });

  it("sendOnce sends a message a single time across retries", async () => {
    const email = new MemoryEmail();
    const message = { to: "a@example.com", subject: "s", text: "t" };

    const first = await sendOnce(outbox, email, key("once"), message);
    const second = await sendOnce(outbox, email, key("once"), message);

    expect([first, second]).toEqual(["sent", "skipped"]);
    expect(email.sent).toHaveLength(1);
  });

  it("prunes sent rows past the cutoff and keeps recent and unsent ones", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await outbox.claim(key("old"), undefined, old, EMAIL_CLAIM_LEASE_MS);
    await outbox.markSent(key("old"), old);
    await outbox.claim(key("recent"), undefined, new Date(), EMAIL_CLAIM_LEASE_MS);
    await outbox.markSent(key("recent"), new Date());
    await outbox.claim(key("pending"), undefined, old, EMAIL_CLAIM_LEASE_MS);

    await outbox.prune(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

    const left = (await db.sentEmail.findMany({ where: { idempotencyKey: { startsWith: run } } })).map(
      (r) => r.idempotencyKey,
    );
    expect(left).toContain(key("recent"));
    expect(left).toContain(key("pending"));
    expect(left).not.toContain(key("old"));
  });
});

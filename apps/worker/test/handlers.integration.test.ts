import { randomBytes } from "node:crypto";
import { ShippedPromptSource } from "@aidp/ai";
import {
  attachmentKey,
  Crypto,
  MemoryEmail,
  MemoryEmailOutbox,
  MemoryJobPublisher,
  MemoryStorage,
  SettingsService,
  type CallerFactory,
  TenantGate,
} from "@aidp/core";
import { describeDb, purgeAuditLog } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { handlers } from "../src/handlers.js";

/** A store that fails its next N prefix deletes, as an object store that hiccups does. */
class FlakyStorage extends MemoryStorage {
  failures = 0;
  override async deletePrefix(prefix: string): Promise<number> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("object store unavailable");
    }
    return super.deletePrefix(prefix);
  }
}

/** The handlers that touch Postgres directly, run twice against a real database (plan 4.2). */
describeDb("worker handlers against Postgres", () => {
  const db = new PrismaClient();
  const crypto = new Crypto(randomBytes(32).toString("base64"));
  const suffix = `wh_${Date.now().toString(36)}`;
  let companyId = "";
  let templateId = "";
  const storage = new FlakyStorage();
  const outbox = new MemoryEmailOutbox();
  const h = handlers({
    db,
    tenants: new TenantGate(db),
    crypto,
    callers: {} as unknown as CallerFactory,
    settings: new SettingsService(db, crypto),
    email: new MemoryEmail(),
    jobs: new MemoryJobPublisher(),
    storage,
    log: { info: () => undefined, warn: () => undefined },
    publicWebUrl: "http://localhost:3000",
    outbox,
    prompts: new ShippedPromptSource(),
  });

  beforeAll(async () => {
    companyId = (await db.company.create({ data: { name: `Worker ${suffix}` } })).id;
    templateId = (
      await db.interviewTemplate.create({
        data: { companyId, key: `k-${suffix}`, name: "T", objective: "o", privacyMode: "anonymous" },
      })
    ).id;
  });

  afterAll(async () => {
    await db.fact.deleteMany({ where: { companyId } });
    await db.attachment.deleteMany({ where: { companyId } });
    const ids = (await db.session.findMany({ where: { companyId }, select: { id: true } })).map((s) => s.id);
    await db.message.deleteMany({ where: { sessionId: { in: ids } } });
    await db.sessionEvent.deleteMany({ where: { sessionId: { in: ids } } });
    await db.session.deleteMany({ where: { companyId } });
    await db.interviewTemplate.deleteMany({ where: { companyId } });
    await purgeAuditLog(db, [companyId]);
    await db.company.delete({ where: { id: companyId } });
    await db.$disconnect();
  });

  const makeSession = async (): Promise<string> => {
    const s = await db.session.create({
      data: { companyId, templateId, status: "completed", summary: "said something", state: { a: 1 } },
    });
    await db.message.create({ data: { companyId, sessionId: s.id, seq: 1, role: "user", content: "hello" } });
    await db.fact.create({
      data: {
        companyId,
        sessionId: s.id,
        kind: "task",
        payload: {},
        extractorVersion: "extraction@1",
        batchEndSeq: 2,
        ordinal: 0,
      },
    });
    await storage.put(attachmentKey(companyId, s.id, "a1"), Buffer.from("bytes"), {
      contentType: "text/plain",
    });
    return s.id;
  };

  it("privacy.delete-session run twice leaves the same result as once", async () => {
    const sessionId = await makeSession();

    await h["privacy.delete-session"]({ sessionId, companyId });
    await h["privacy.delete-session"]({ sessionId, companyId });

    expect(await db.message.count({ where: { sessionId } })).toBe(0);
    expect(await db.fact.count({ where: { sessionId } })).toBe(0);
    expect(await storage.head(attachmentKey(companyId, sessionId, "a1"))).toBeNull();
    expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({
      status: "deleted",
      summary: "",
    });
  });

  it("privacy.delete-session fails loudly when the files will not delete, and the retry finishes", async () => {
    const sessionId = await makeSession();
    storage.failures = 1;

    await expect(h["privacy.delete-session"]({ sessionId, companyId })).rejects.toThrow(
      /could not delete the stored files/,
    );
    // The rows went in the first attempt; the bytes are what is left, and the queue will retry.
    expect(await db.message.count({ where: { sessionId } })).toBe(0);
    expect(await storage.head(attachmentKey(companyId, sessionId, "a1"))).not.toBeNull();

    await h["privacy.delete-session"]({ sessionId, companyId });

    expect(await storage.head(attachmentKey(companyId, sessionId, "a1"))).toBeNull();
  });

  it("privacy.retention-sweep prunes old sent emails and is safe to run twice", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await outbox.claim("old-key", undefined, old, 1);
    await outbox.markSent("old-key", old);
    await outbox.claim("new-key", undefined, new Date(), 1);
    await outbox.markSent("new-key", new Date());

    await h["privacy.retention-sweep"]({});
    await h["privacy.retention-sweep"]({});

    expect([...outbox.rows.keys()]).toEqual(["new-key"]);
  });
});

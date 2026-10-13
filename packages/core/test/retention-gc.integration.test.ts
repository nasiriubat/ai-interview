import { randomBytes } from "node:crypto";
import { currentTenant } from "@aidp/db";
import { describeDb } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Crypto } from "../src/crypto.js";
import {
  RETENTION_GC_MAX_PER_SWEEP,
  STORAGE_GC_ACTION,
  STORAGE_GC_GRACE_MS,
  deleteSessionData,
  runRetentionSweep,
  type TenantSweep,
} from "../src/privacy/retention.js";
import { SettingsService } from "../src/settings/service.js";
import { attachmentKey, MemoryStorage, type PrefixInfo, type StoragePort } from "../src/storage/index.js";

/** A store whose `deletePrefix` fails a set number of times, as an object store that hiccups does. */
class FlakyStorage extends MemoryStorage {
  failures = 0;
  readonly listed: string[] = [];
  /** Every prefix removal, with the tenant scope the sweep was running in when it asked. */
  readonly removals: { tenant: string | null; prefix: string }[] = [];
  override async deletePrefix(prefix: string): Promise<number> {
    this.removals.push({ tenant: currentTenant(), prefix });
    if (this.failures > 0) {
      this.failures--;
      throw new Error("object store unavailable");
    }
    return super.deletePrefix(prefix);
  }
  override async listPrefixes(parent: string): Promise<PrefixInfo[]> {
    this.listed.push(parent);
    return super.listPrefixes(parent);
  }
}

const monthsAgo = (n: number): Date => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};

/**
 * Storage orphan recovery (D-103). The retention sweep used to log a failed `deletePrefix` and move
 * on, and a session it had anonymized never matched the sweep again, so the bytes of a participant
 * who asked to be forgotten stayed on disk indefinitely. The GC pass at the end of each tenant's
 * sweep lists storage instead of rows, so it needs no memory of what failed.
 */
describeDb("retention sweep storage GC", () => {
  const db = new PrismaClient();
  const crypto = new Crypto(randomBytes(32).toString("base64"));
  const settings = new SettingsService(db, crypto);
  const warnings: string[] = [];
  const log = {
    info: () => undefined,
    warn: (m: string) => warnings.push(m),
  };
  const suffix = `gc_${Date.now().toString(36)}`;
  let companyId = "";
  let otherCompanyId = "";
  let templateId = "";

  const sweep = async (storage: StoragePort, over: { now?: () => Date } = {}): Promise<TenantSweep> => {
    const all = await runRetentionSweep({ db, settings, log, storage, ...over });
    const mine = all.find((s) => s.companyId === companyId);
    if (!mine) throw new Error("no sweep for the test tenant");
    return mine;
  };
  const expiredSession = () =>
    db.session.create({
      data: {
        companyId,
        templateId,
        status: "completed",
        createdAt: monthsAgo(40),
        endedAt: monthsAgo(39),
      },
    });
  const hoursFromNow = (h: number) => () => new Date(Date.now() + h * 60 * 60 * 1000);

  beforeAll(async () => {
    companyId = (await db.company.create({ data: { name: `GC ${suffix}` } })).id;
    otherCompanyId = (await db.company.create({ data: { name: `GC other ${suffix}` } })).id;
    const template = async (cid: string) =>
      (
        await db.interviewTemplate.create({
          data: { companyId: cid, key: `k-${cid}`, name: "T", objective: "o", privacyMode: "anonymous" },
        })
      ).id;
    templateId = await template(companyId);
    await template(otherCompanyId);
  });

  afterAll(async () => {
    for (const id of [companyId, otherCompanyId]) {
      await db.attachment.deleteMany({ where: { companyId: id } });
      await db.session.deleteMany({ where: { companyId: id } });
      await db.interviewTemplate.deleteMany({ where: { companyId: id } });
      await db.auditLog.deleteMany({ where: { companyId: id } });
      await db.company.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("a deletePrefix that fails is not silently lost: the next sweep removes the bytes", async () => {
    // Written two hours ago, so the grace window has passed by the time the sweep looks.
    const storage = new FlakyStorage(() => new Date(Date.now() - 2 * 60 * 60 * 1000));
    const session = await expiredSession();
    const key = attachmentKey(companyId, session.id, "att1");
    await storage.put(key, Buffer.from("the participant's recording"), { contentType: "audio/webm" });
    // Two failures: the delete after the row batch, and the GC pass that closes the same sweep.
    storage.failures = 2;

    // Sweep 1: the row is anonymized, the deletes throw, and the sweep says so out loud.
    const first = await sweep(storage);
    expect(first.deleted).toBeGreaterThanOrEqual(1);
    expect(first.bytesFailed).toBeGreaterThanOrEqual(2);
    expect(await storage.head(key)).not.toBeNull();
    expect(warnings.some((w) => w.includes("rows but not its stored files"))).toBe(true);
    expect(warnings.some((w) => w.includes("left stored files behind"))).toBe(true);

    // The session is anonymized now, so the row sweep will never look at it again. This is the
    // case that used to leak.
    expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({
      status: "deleted",
    });

    const second = await sweep(storage);
    expect(second.orphansCollected).toBe(1);
    expect(second.bytesFailed).toBe(0);
    expect(await storage.head(key)).toBeNull();
    const audit = await db.auditLog.findFirst({ where: { companyId, action: STORAGE_GC_ACTION } });
    expect(audit?.diff).toMatchObject({ orphansCollected: 1 });
  });

  it("collects bytes whose session row never existed or is long gone", async () => {
    const storage = new FlakyStorage(() => new Date(Date.now() - 2 * 60 * 60 * 1000));
    const key = attachmentKey(companyId, "cksessionthatwasneverrecorded", "a1");
    await storage.put(key, Buffer.from("stray"), { contentType: "text/plain" });

    const r = await sweep(storage);

    expect(r.orphansCollected).toBe(1);
    expect(await storage.head(key)).toBeNull();
  });

  it("leaves a live session's files alone", async () => {
    const storage = new FlakyStorage(() => new Date(Date.now() - 2 * 60 * 60 * 1000));
    const live = await db.session.create({
      data: { companyId, templateId, status: "active" },
    });
    const key = attachmentKey(companyId, live.id, "a1");
    await storage.put(key, Buffer.from("in use"), { contentType: "text/plain" });

    const r = await sweep(storage);

    expect(r.orphansCollected).toBe(0);
    expect(await storage.head(key)).not.toBeNull();
  });

  it("does not collect a directory written inside the grace window, then does once it has passed", async () => {
    // Stamped 'now': an upload for a session whose row is about to be committed.
    const storage = new FlakyStorage();
    const key = attachmentKey(companyId, "ckuploadinflight", "a1");
    await storage.put(key, Buffer.from("arriving"), { contentType: "text/plain" });

    const early = await sweep(storage);
    expect(early.orphansCollected).toBe(0);
    expect(await storage.head(key)).not.toBeNull();

    const later = await sweep(storage, { now: hoursFromNow(1) });
    expect(STORAGE_GC_GRACE_MS).toBe(60 * 60 * 1000);
    expect(later.orphansCollected).toBe(1);
    expect(await storage.head(key)).toBeNull();
  });

  it("never removes a prefix outside the tenant whose scope the sweep is running in", async () => {
    const storage = new FlakyStorage(() => new Date(Date.now() - 2 * 60 * 60 * 1000));
    await storage.put(attachmentKey(otherCompanyId, "ckotherorphan", "a1"), Buffer.from("theirs"), {
      contentType: "text/plain",
    });
    await storage.put(attachmentKey(companyId, "ckmyorphan", "a1"), Buffer.from("mine"), {
      contentType: "text/plain",
    });

    await sweep(storage);

    expect(storage.removals.length).toBeGreaterThanOrEqual(2);
    for (const r of storage.removals) expect(r.prefix.startsWith(`${r.tenant}/`)).toBe(true);
    for (const parent of storage.listed) expect(parent).toMatch(/^[A-Za-z0-9_-]+\/$/);
    // Both orphans are collected, each by its own tenant's pass.
    expect(await storage.head(attachmentKey(companyId, "ckmyorphan", "a1"))).toBeNull();
    expect(await storage.head(attachmentKey(otherCompanyId, "ckotherorphan", "a1"))).toBeNull();
  });

  it("caps the work per sweep and finishes on the next one", async () => {
    const storage = new FlakyStorage(() => new Date(Date.now() - 2 * 60 * 60 * 1000));
    const total = RETENTION_GC_MAX_PER_SWEEP + 3;
    for (let i = 0; i < total; i++)
      await storage.put(attachmentKey(companyId, `ckbulk${i}`, "a"), Buffer.from("x"), {
        contentType: "text/plain",
      });

    const first = await sweep(storage);
    const second = await sweep(storage);

    expect(first.orphansCollected).toBe(RETENTION_GC_MAX_PER_SWEEP);
    expect(second.orphansCollected).toBe(3);
  });

  it("an expired recording whose file will not delete keeps its row, so it is retried", async () => {
    const storage = new FlakyStorage(() => new Date(Date.now() - 2 * 60 * 60 * 1000));
    const session = await db.session.create({ data: { companyId, templateId, status: "completed" } });
    const key = attachmentKey(companyId, session.id, "audio1");
    await storage.put(key, Buffer.from("voice"), { contentType: "audio/webm" });
    const row = await db.attachment.create({
      data: {
        companyId,
        sessionId: session.id,
        kind: "audio",
        filename: "a.webm",
        mime: "audio/webm",
        sizeBytes: 5,
        storageKey: key,
        status: "ready",
        ingestedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      },
    });
    const flakyDelete = storage.delete.bind(storage);
    let failNext = true;
    storage.delete = async (k: string) => {
      if (failNext) {
        failNext = false;
        throw new Error("object store unavailable");
      }
      return flakyDelete(k);
    };

    const first = await sweep(storage);
    expect(first.audioDeleted).toBe(0);
    expect(first.bytesFailed).toBe(1);
    expect(await db.attachment.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect(await storage.head(key)).not.toBeNull();

    const second = await sweep(storage);
    expect(second.audioDeleted).toBe(1);
    expect(await db.attachment.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await storage.head(key)).toBeNull();
  });

  it("deleteSessionData reports a failed file delete so the job can retry it", async () => {
    const storage = new FlakyStorage();
    const session = await expiredSession();
    await storage.put(attachmentKey(companyId, session.id, "a"), Buffer.from("x"), {
      contentType: "text/plain",
    });
    storage.failures = 1;

    const r = await deleteSessionData(db, session.id, { storage, companyId, log });

    expect(r.bytesFailed).toBe(1);
  });
});

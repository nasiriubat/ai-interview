import { randomBytes } from "node:crypto";
import { describeDb, purgeAuditLog } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crypto } from "../src/crypto.js";
import {
  RETENTION_SWEEP_ACTION,
  retentionStatus,
  runRetentionSweep,
  type TenantSweep,
} from "../src/privacy/retention.js";
import { SettingsService } from "../src/settings/service.js";
import { attachmentKey, MemoryStorage } from "../src/storage/index.js";

const suite = describeDb;

const monthsAgo = (n: number): Date => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};

suite("retention sweep (spec 11)", () => {
  const db = new PrismaClient();
  const crypto = new Crypto(randomBytes(32).toString("base64"));
  const settings = new SettingsService(db, crypto);
  const messages: string[] = [];
  const log = {
    info: (m: string, meta?: Record<string, unknown>) => messages.push(`${m} ${JSON.stringify(meta)}`),
    warn: () => undefined,
  };

  const suffix = `ret_${Date.now().toString(36)}`;
  let companyId = "";
  let strictCompanyId = "";
  let templateId = "";
  let strictTemplateId = "";
  let providerId = "";

  /** A session plus one of everything that hangs off it. */
  const makeSession = async (
    company: string,
    template: string,
    when: { endedAt?: Date | null; createdAt?: Date },
  ): Promise<string> => {
    const session = await db.session.create({
      data: {
        companyId: company,
        templateId: template,
        status: "completed",
        state: { facts: [{ kind: "task", text: "secret" }] },
        summary: "a participant said something",
        ...(when.createdAt ? { createdAt: when.createdAt } : {}),
        ...(when.endedAt === undefined ? {} : { endedAt: when.endedAt }),
      },
    });
    await db.message.create({
      data: { companyId: company, sessionId: session.id, seq: 1, role: "user", content: "my name is Alice" },
    });
    await db.sessionEvent.create({
      data: { companyId: company, sessionId: session.id, seq: 1, type: "state_delta", payload: { a: 1 } },
    });
    await db.fact.create({
      data: {
        companyId: company,
        sessionId: session.id,
        kind: "task",
        payload: { text: "t" },
        extractorVersion: "extraction@1",
        batchEndSeq: 2,
        ordinal: 0,
      },
    });
    await db.attachment.create({
      data: {
        companyId: company,
        sessionId: session.id,
        kind: "document",
        filename: "cv.pdf",
        mime: "application/pdf",
        sizeBytes: 10,
        storageKey: `k-${session.id}`,
      },
    });
    await db.llmCall.create({
      data: {
        companyId: company,
        purpose: "interview_turn",
        providerId,
        model: "fake-model",
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 20,
        status: "ok",
        costCents: 1.5,
        sessionId: session.id,
      },
    });
    return session.id;
  };

  const sweepFor = (sweeps: TenantSweep[], id: string): TenantSweep => {
    const found = sweeps.find((s) => s.companyId === id);
    if (!found) throw new Error(`no sweep for ${id}`);
    return found;
  };

  beforeAll(async () => {
    const company = await db.company.create({ data: { name: `Retention ${suffix}` } });
    const strict = await db.company.create({ data: { name: `Strict ${suffix}` } });
    companyId = company.id;
    strictCompanyId = strict.id;
    const template = async (cid: string) =>
      (
        await db.interviewTemplate.create({
          data: { companyId: cid, key: `k-${cid}`, name: "T", objective: "o", privacyMode: "identified" },
        })
      ).id;
    templateId = await template(companyId);
    strictTemplateId = await template(strictCompanyId);
    providerId = (
      await db.provider.create({
        data: {
          companyId,
          kind: "openai_compatible",
          name: "fake",
          apiKeyEnc: crypto.encrypt("k", "provider.apiKey"),
        },
      })
    ).id;
  });

  afterAll(async () => {
    // The ledger goes first for both tenants: the strict tenant's calls point at the other's provider.
    await db.llmCall.deleteMany({ where: { companyId: { in: [companyId, strictCompanyId] } } });
    for (const id of [companyId, strictCompanyId]) {
      await db.attachment.deleteMany({ where: { companyId: id } });
      await db.fact.deleteMany({ where: { companyId: id } });
      const sessions = await db.session.findMany({ where: { companyId: id }, select: { id: true } });
      const ids = sessions.map((s) => s.id);
      await db.message.deleteMany({ where: { sessionId: { in: ids } } });
      await db.sessionEvent.deleteMany({ where: { sessionId: { in: ids } } });
      await db.session.deleteMany({ where: { companyId: id } });
      await db.provider.deleteMany({ where: { companyId: id } });
      await db.interviewTemplate.deleteMany({ where: { companyId: id } });
      await purgeAuditLog(db, [id]);
      await db.setting.deleteMany({ where: { scopeId: id } });
      await db.company.delete({ where: { id } });
    }
    await db.$disconnect();
  });

  it("sweeps what is past the window, keeps what is inside it, and is a no-op the second time", async () => {
    // 30 months old: past the 24-month default. 25 months but never ended: judged by createdAt.
    const expired = await makeSession(companyId, templateId, {
      createdAt: monthsAgo(31),
      endedAt: monthsAgo(30),
    });
    const abandoned = await makeSession(companyId, templateId, {
      createdAt: monthsAgo(25),
      endedAt: null,
    });
    const fresh = await makeSession(companyId, templateId, {
      createdAt: monthsAgo(1),
      endedAt: monthsAgo(1),
    });

    const first = await runRetentionSweep({ db, settings, log, companyIds: [companyId, strictCompanyId] });
    const mine = sweepFor(first, companyId);
    expect(mine.deleted).toBe(2);
    expect(mine.examined).toBe(2);
    expect(mine.retentionMonths).toBe(24);
    expect(mine.truncated).toBe(false);

    const statuses = await db.session.findMany({
      where: { id: { in: [expired, abandoned, fresh] } },
      select: { id: true, status: true, summary: true, state: true },
    });
    const byId = new Map(statuses.map((s) => [s.id, s]));
    for (const id of [expired, abandoned]) {
      const row = byId.get(id);
      expect(row?.status).toBe("deleted");
      expect(row?.summary).toBe("");
      expect(row?.state).toEqual({});
    }
    expect(byId.get(fresh)?.status).toBe("completed");
    expect(byId.get(fresh)?.summary).not.toBe("");

    // Everything that could identify the participant is gone; the cost ledger is not.
    expect(await db.message.count({ where: { sessionId: expired } })).toBe(0);
    expect(await db.sessionEvent.count({ where: { sessionId: expired } })).toBe(0);
    expect(await db.fact.count({ where: { sessionId: expired } })).toBe(0);
    expect(await db.attachment.count({ where: { sessionId: expired } })).toBe(0);
    expect(await db.llmCall.count({ where: { sessionId: expired } })).toBe(1);
    expect(await db.message.count({ where: { sessionId: fresh } })).toBe(1);

    // The audit row says what happened without naming anybody.
    const audits = await db.auditLog.findMany({ where: { companyId, action: RETENTION_SWEEP_ACTION } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.targetType).toBe("company");
    expect(audits[0]?.targetId).toBe(companyId);
    expect(audits[0]?.actorId).toBeNull();
    const diff = audits[0]?.diff as { deleted: number; retentionMonths: number; olderThan: string };
    expect(diff.deleted).toBe(2);
    expect(diff.retentionMonths).toBe(24);
    expect(Date.parse(diff.olderThan)).toBeLessThan(Date.now());
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain(expired);

    // Second run: nothing left to do, and no second audit row.
    const second = await runRetentionSweep({ db, settings, log, companyIds: [companyId, strictCompanyId] });
    expect(sweepFor(second, companyId).deleted).toBe(0);
    expect(sweepFor(second, companyId).examined).toBe(0);
    expect(await db.auditLog.count({ where: { companyId, action: RETENTION_SWEEP_ACTION } })).toBe(1);

    // The log line carries counts and the policy, never a participant.
    const line = messages.find((m) => m.startsWith("retention sweep") && m.includes(companyId));
    expect(line).toContain('"deleted":2');
    expect(line).not.toContain("Alice");
  });

  it("lets a tenant be stricter than the platform default", async () => {
    // Inside the platform's 24 months, outside this tenant's 6.
    const recent = await makeSession(strictCompanyId, strictTemplateId, {
      createdAt: monthsAgo(9),
      endedAt: monthsAgo(8),
    });
    const veryRecent = await makeSession(strictCompanyId, strictTemplateId, {
      createdAt: monthsAgo(2),
      endedAt: monthsAgo(2),
    });

    const untouched = await runRetentionSweep({
      db,
      settings,
      log,
      companyIds: [companyId, strictCompanyId],
    });
    expect(sweepFor(untouched, strictCompanyId).deleted).toBe(0);

    await settings.set({ scope: "tenant", scopeId: strictCompanyId }, { "privacy.retentionMonths": 6 }, "u1");
    const sweeps = await runRetentionSweep({ db, settings, log, companyIds: [companyId, strictCompanyId] });
    const strict = sweepFor(sweeps, strictCompanyId);
    expect(strict.retentionMonths).toBe(6);
    expect(strict.deleted).toBe(1);
    expect((await db.session.findUniqueOrThrow({ where: { id: recent } })).status).toBe("deleted");
    expect((await db.session.findUniqueOrThrow({ where: { id: veryRecent } })).status).toBe("completed");
    // Other tenants keep the platform window.
    expect(sweepFor(sweeps, companyId).retentionMonths).toBe(24);
  });

  it("a tenant-scoped sweep neither reports nor touches another tenant's expired sessions", async () => {
    const other = await makeSession(companyId, templateId, {
      createdAt: monthsAgo(50),
      endedAt: monthsAgo(49),
    });
    const scoped = await runRetentionSweep({ db, settings, log, companyIds: [strictCompanyId] });
    expect(scoped.map((s) => s.companyId)).toEqual([strictCompanyId]);
    expect((await db.session.findUniqueOrThrow({ where: { id: other } })).status).toBe("completed");
    // Leave nothing for the tests that follow to trip over.
    await runRetentionSweep({ db, settings, log, companyIds: [companyId] });
    expect((await db.session.findUniqueOrThrow({ where: { id: other } })).status).toBe("deleted");
  });

  it("works in bounded batches and reports what a run left behind", async () => {
    for (let i = 0; i < 5; i++) {
      await makeSession(companyId, templateId, { createdAt: monthsAgo(40), endedAt: monthsAgo(39) });
    }
    const capped = await runRetentionSweep({
      db,
      settings,
      log,
      companyIds: [companyId, strictCompanyId],
      batchSize: 2,
      maxBatches: 2,
    });
    const mine = sweepFor(capped, companyId);
    expect(mine.deleted).toBe(4);
    expect(mine.truncated).toBe(true);
    const rest = await runRetentionSweep({
      db,
      settings,
      log,
      companyIds: [companyId, strictCompanyId],
      batchSize: 2,
      maxBatches: 2,
    });
    expect(sweepFor(rest, companyId).deleted).toBe(1);
    expect(sweepFor(rest, companyId).truncated).toBe(false);
  });

  it("reports the policy and what is currently past it", async () => {
    const before = await retentionStatus({ db, settings }, companyId);
    expect(before.retentionMonths).toBe(24);
    expect(before.expiredSessions).toBe(0);
    expect(before.lastSweepAt).not.toBeNull();

    await makeSession(companyId, templateId, { createdAt: monthsAgo(50), endedAt: monthsAgo(49) });
    const after = await retentionStatus({ db, settings }, companyId);
    expect(after.expiredSessions).toBe(1);
    expect(Date.parse(after.oldestSessionAt ?? "")).toBeLessThan(monthsAgo(48).getTime());

    await runRetentionSweep({ db, settings, log, companyIds: [companyId, strictCompanyId] });
    const swept = await retentionStatus({ db, settings }, companyId);
    expect(swept.expiredSessions).toBe(0);
  });

  /**
   * Bytes live outside Postgres from phase 4, so "deleted" has to mean both. A sweep that removed
   * the rows and left the recordings on disk would be the worst possible outcome: the data is
   * still there, and nothing knows where.
   */
  describe("stored files", () => {
    it("takes a session's uploaded bytes with its rows", async () => {
      const storage = new MemoryStorage();
      const sessionId = await makeSession(companyId, templateId, {
        createdAt: monthsAgo(40),
        endedAt: monthsAgo(39),
      });
      const key = attachmentKey(companyId, sessionId, "att1");
      await db.attachment.update({
        where: { id: (await db.attachment.findFirstOrThrow({ where: { sessionId } })).id },
        data: { storageKey: key },
      });
      await storage.put(key, Buffer.from("the participant's document"), { contentType: "text/plain" });

      await runRetentionSweep({ db, settings, log, companyIds: [companyId, strictCompanyId], storage });

      expect(await storage.head(key)).toBeNull();
    });

    it("sweeps a voice recording on its own, shorter clock", async () => {
      const storage = new MemoryStorage();
      // A live session, well inside the session retention window: only the audio clock applies.
      const session = await db.session.create({
        data: { companyId, templateId, status: "completed", state: {}, summary: "" },
      });
      const oldKey = attachmentKey(companyId, session.id, "oldaudio");
      const freshKey = attachmentKey(companyId, session.id, "newaudio");
      await storage.put(oldKey, Buffer.from("old voice"), { contentType: "audio/webm" });
      await storage.put(freshKey, Buffer.from("new voice"), { contentType: "audio/webm" });
      const old = await db.attachment.create({
        data: {
          companyId,
          sessionId: session.id,
          kind: "audio",
          filename: "old.webm",
          mime: "audio/webm",
          sizeBytes: 9,
          storageKey: oldKey,
          status: "ready",
          ingestedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        },
      });
      const fresh = await db.attachment.create({
        data: {
          companyId,
          sessionId: session.id,
          kind: "audio",
          filename: "new.webm",
          mime: "audio/webm",
          sizeBytes: 9,
          storageKey: freshKey,
          status: "ready",
          ingestedAt: new Date(),
        },
      });

      const sweeps = await runRetentionSweep({
        db,
        settings,
        log,
        companyIds: [companyId, strictCompanyId],
        storage,
      });

      // Default is 365 days: the old recording goes, the recent one stays.
      expect(await db.attachment.findUnique({ where: { id: old.id } })).toBeNull();
      expect(await db.attachment.findUnique({ where: { id: fresh.id } })).not.toBeNull();
      expect(await storage.head(oldKey)).toBeNull();
      expect(await storage.head(freshKey)).not.toBeNull();
      expect(sweepFor(sweeps, companyId).audioDeleted).toBeGreaterThanOrEqual(1);

      // The transcript is the durable record and is untouched by the audio clock.
      expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
    });

    it("leaves a recording that was never transcribed, because it is not yet redundant", async () => {
      const storage = new MemoryStorage();
      const session = await db.session.create({
        data: { companyId, templateId, status: "active", state: {}, summary: "" },
      });
      const key = attachmentKey(companyId, session.id, "stuck");
      await storage.put(key, Buffer.from("never transcribed"), { contentType: "audio/webm" });
      const stuck = await db.attachment.create({
        data: {
          companyId,
          sessionId: session.id,
          kind: "audio",
          filename: "stuck.webm",
          mime: "audio/webm",
          sizeBytes: 9,
          storageKey: key,
          status: "failed",
          // Old enough to be swept, but transcription never finished, so the clock never started.
          createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
          ingestedAt: null,
        },
      });

      await runRetentionSweep({ db, settings, log, companyIds: [companyId, strictCompanyId], storage });

      expect(await db.attachment.findUnique({ where: { id: stuck.id } })).not.toBeNull();
    });
  });
});

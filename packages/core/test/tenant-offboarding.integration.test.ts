import { randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describeDb } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MemoryAlerts } from "../src/alerts/port.js";
import { Crypto } from "../src/crypto.js";
import { MemoryJobPublisher } from "../src/jobs/definitions.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { ArchiveFormatError } from "../src/tenancy/offboarding/archive-crypto.js";
import { ErasureLedger, reapplyErasures } from "../src/tenancy/offboarding/erasure-ledger.js";
import { TenantExporter } from "../src/tenancy/offboarding/export.js";
import { PurgeIncompleteError, TenantPurger } from "../src/tenancy/offboarding/purge.js";
import { RETAINED_TABLES, tenantTables } from "../src/tenancy/offboarding/tables.js";

/**
 * Tenant export and offboarding (D-225, D-226, security plan A5).
 *
 * The claim worth proving is the one the contract makes: after offboarding there is no row with
 * the tenant's id in any table that carries one, and no byte under its storage prefixes, except
 * the statements kept for invoicing. The table list is read from the catalogue by the code under
 * test and again, independently, by this test, so a table added later is covered by both.
 */
describeDb("tenant export and offboarding", () => {
  const db = new PrismaClient();
  const crypto = new Crypto(randomBytes(32).toString("base64"));
  const storage = new MemoryStorage();
  const alerts = new MemoryAlerts();
  let dir = "";
  let ledgerFile = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aidp-offboard-"));
    ledgerFile = join(dir, "erasures.jsonl");
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  async function seedTenant(): Promise<{
    companyId: string;
    name: string;
    sessionId: string;
    attachmentKey: string;
    attachmentBytes: Buffer;
    userEmail: string;
    platformProviderId: string;
  }> {
    const tag = randomBytes(5).toString("hex");
    const name = `Offboard ${tag}`;
    const company = await db.company.create({ data: { name, status: "suspended" } });
    const companyId = company.id;
    const userEmail = `staff-${tag}@offboard.test`;
    const user = await db.user.create({ data: { companyId, email: userEmail, role: "admin" } });
    const template = await db.interviewTemplate.create({
      data: { companyId, key: `k-${tag}`, name: "T", objective: "o", privacyMode: "anonymous" },
    });
    const campaign = await db.campaign.create({
      data: {
        companyId,
        templateId: template.id,
        name: "C",
        participationMode: "anonymous",
        linkTokenHash: `link-${tag}`,
        verification: "open",
        status: "open",
        createdById: user.id,
      },
    });
    const session = await db.session.create({
      data: { companyId, templateId: template.id, campaignId: campaign.id, status: "completed" },
    });
    await db.message.create({
      data: { companyId, sessionId: session.id, seq: 1, role: "user", content: `hello ${tag}` },
    });
    const provider = await db.provider.create({
      data: {
        companyId,
        kind: "openai_compatible",
        name: "tenant provider",
        apiKeyEnc: crypto.encrypt(`sk-secret-${tag}`, "provider.apiKey"),
      },
    });
    await db.modelPrice.create({
      data: {
        providerId: provider.id,
        model: "m",
        inputPerMtok: 1,
        cachedInputPerMtok: 1,
        outputPerMtok: 2,
        source: "admin",
      },
    });
    await db.route.create({
      data: {
        companyId,
        purpose: "interview_turn",
        providerId: provider.id,
        model: "m",
        maxOutputTokens: 100,
      },
    });
    await db.fallbackRoute.create({
      data: {
        companyId,
        purpose: "interview_turn",
        providerId: provider.id,
        model: "m2",
        maxOutputTokens: 100,
      },
    });
    await db.budget.create({
      data: { companyId, scope: "tenant", scopeId: companyId, limitCents: 1000, period: "month" },
    });
    await db.llmCall.create({
      data: {
        companyId,
        purpose: "interview_turn",
        providerId: provider.id,
        model: "m",
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 20,
        status: "ok",
        costCents: 1.5,
        sessionId: session.id,
        campaignId: campaign.id,
        firstTokenMs: 400,
      },
    });
    const attachmentBytes = Buffer.from(`recorded-audio-${tag}`);
    const attachmentKey = `${companyId}/${session.id}/att${tag}`;
    await storage.put(attachmentKey, attachmentBytes, { contentType: "audio/webm" });
    await db.attachment.create({
      data: {
        companyId,
        sessionId: session.id,
        kind: "audio",
        filename: "answer.webm",
        mime: "audio/webm",
        sizeBytes: attachmentBytes.length,
        storageKey: attachmentKey,
      },
    });
    await db.setting.create({
      data: {
        scope: "tenant",
        scopeId: companyId,
        companyId,
        key: "branding.productName",
        value: "Acme interviews",
      },
    });
    await db.opsAlert.create({
      data: { key: `test:${tag}`, kind: "budget.warning", severity: "info", companyId, title: "t" },
    });
    await db.auditLog.create({
      data: {
        companyId,
        actorId: user.id,
        action: "tenant.update",
        targetType: "company",
        targetId: companyId,
      },
    });
    await db.auditLog.create({
      data: {
        companyId,
        actorId: user.id,
        action: "campaign.create",
        targetType: "campaign",
        targetId: campaign.id,
      },
    });
    await db.tenantStatement.create({
      data: {
        companyId,
        month: "2026-09",
        lines: [],
        totals: { costCents: 12, estimatedCents: 0, calls: 1, byPurpose: {}, byProvider: {}, budgets: [] },
        counts: {},
      },
    });
    await db.verificationToken.create({
      data: { identifier: userEmail, token: `vt-${tag}`, expires: new Date(Date.now() + 600_000) },
    });
    // A platform-level provider that the tenant's rows must not touch.
    const platform = await db.provider.create({
      data: {
        companyId: null,
        kind: "openai_compatible",
        name: `platform ${tag}`,
        apiKeyEnc: crypto.encrypt("platform", "provider.apiKey"),
      },
    });
    return {
      companyId,
      name,
      sessionId: session.id,
      attachmentKey,
      attachmentBytes,
      userEmail,
      platformProviderId: platform.id,
    };
  }

  /** Every tenant table with its row count for a company, read from the catalogue. */
  async function rowsLeft(companyId: string): Promise<Record<string, number>> {
    const tables = await db.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'companyId'`,
    );
    expect(tables.length).toBeGreaterThan(20);
    const out: Record<string, number> = {};
    for (const { table_name } of tables) {
      const r = await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${table_name}" WHERE "companyId" = $1`,
        companyId,
      );
      if ((r[0]?.n ?? 0) > 0) out[table_name] = r[0]?.n ?? 0;
    }
    return out;
  }

  /** The entries of a stored-method zip with a data descriptor, as the writer produces them. */
  function unzip(zip: Buffer): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = zip.readUInt16LE(eocd + 10);
    let p = zip.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      expect(zip.readUInt32LE(p)).toBe(0x02014b50);
      const method = zip.readUInt16LE(p + 10);
      const size = zip.readUInt32LE(p + 24);
      const nameLen = zip.readUInt16LE(p + 28);
      const extraLen = zip.readUInt16LE(p + 30);
      const commentLen = zip.readUInt16LE(p + 32);
      const local = zip.readUInt32LE(p + 42);
      const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      const lNameLen = zip.readUInt16LE(local + 26);
      const lExtra = zip.readUInt16LE(local + 28);
      const start = local + 30 + lNameLen + lExtra;
      const raw = zip.subarray(start, start + size);
      out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks);
  }

  it("exports a signed, sealed archive that holds the tenant's rows and files and none of its secrets", async () => {
    const t = await seedTenant();
    const exporter = new TenantExporter({ db, storage, crypto });
    const meta = await exporter.run(t.companyId, "operator-1");

    // At rest it is ciphertext: the recording's bytes are nowhere in what was stored.
    const raw = await storage.get(`exports/${t.companyId}/${meta.stamp}/archive`);
    const stored = await collect(raw as AsyncIterable<Buffer>);
    expect(stored.includes(t.attachmentBytes)).toBe(false);
    expect(stored.includes(Buffer.from("tenant provider"))).toBe(false);
    expect(meta.bytes).toBe(stored.length);

    const zip = await collect(await exporter.open(t.companyId, meta.stamp));
    const files = unzip(zip);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        "README.txt",
        "manifest.json",
        "manifest.sig",
        "data/Session.jsonl",
        "data/User.jsonl",
      ]),
    );
    const sessions = files.get("data/Session.jsonl")!.toString("utf8").trim().split("\n");
    expect(sessions).toHaveLength(1);
    expect(JSON.parse(sessions[0]!).id).toBe(t.sessionId);
    expect(files.get("data/Message.jsonl")!.toString("utf8")).toContain("hello ");

    // The upload came along, byte for byte.
    const upload = [...files].find(([name]) => name.startsWith("uploads/"));
    expect(upload?.[1].equals(t.attachmentBytes)).toBe(true);

    // Sealed secrets and token hashes were left out.
    const providerFile = files.get("data/Provider.jsonl")!.toString("utf8");
    expect(providerFile).toContain("tenant provider");
    expect(providerFile).not.toContain("apiKeyEnc");
    expect(providerFile).not.toContain("v2.");
    expect(files.get("data/Campaign.jsonl")!.toString("utf8")).not.toContain("linkTokenHash");

    // The manifest is signed, every entry's digest is right, and a wrong signature is refused.
    const manifest = files.get("manifest.json")!;
    const signature = files.get("manifest.sig")!.toString("utf8");
    expect(exporter.verifySignature(t.companyId, manifest, signature)).toBe(true);
    expect(exporter.verifySignature(t.companyId, manifest, "0".repeat(64))).toBe(false);
    expect(exporter.verifySignature("another-company", manifest, signature)).toBe(false);
    expect(meta.signature).toBe(signature.trim());
    const parsed = JSON.parse(manifest.toString("utf8")) as {
      entries: { path: string; bytes: number }[];
    };
    for (const e of parsed.entries) expect(files.get(e.path)?.length, e.path).toBe(e.bytes);
    expect(parsed.entries.map((e) => e.path)).toContain("data/AuditLog.jsonl");
  });

  it("refuses an archive that was tampered with or truncated", async () => {
    const t = await seedTenant();
    const exporter = new TenantExporter({ db, storage, crypto });
    const meta = await exporter.run(t.companyId, "op");
    const key = `exports/${t.companyId}/${meta.stamp}/archive`;
    const good = await collect((await storage.get(key)) as AsyncIterable<Buffer>);

    const flipped = Buffer.from(good);
    flipped[flipped.length - 40] = (flipped[flipped.length - 40] ?? 0) ^ 0xff;
    await storage.put(key, flipped, { contentType: "application/octet-stream" });
    await expect(collect(await exporter.open(t.companyId, meta.stamp))).rejects.toThrow();

    // Truncated at a segment boundary is still detected: the last segment is flagged as last.
    await storage.put(key, good.subarray(0, good.length - 20), { contentType: "application/octet-stream" });
    await expect(collect(await exporter.open(t.companyId, meta.stamp))).rejects.toBeInstanceOf(
      ArchiveFormatError,
    );

    // A key that is not in the ring cannot open it.
    await storage.put(key, good, { contentType: "application/octet-stream" });
    const stranger = new TenantExporter({
      db,
      storage,
      crypto: new Crypto(randomBytes(32).toString("base64")),
    });
    await expect(collect(await stranger.open(t.companyId, meta.stamp))).rejects.toBeInstanceOf(
      ArchiveFormatError,
    );
  });

  it("offboarding leaves zero rows and zero bytes for the tenant, and keeps the statements", async () => {
    const t = await seedTenant();
    const exporter = new TenantExporter({ db, storage, crypto });
    await exporter.run(t.companyId, "operator-1");
    expect(Object.keys(await rowsLeft(t.companyId)).length).toBeGreaterThan(15);
    expect(await storage.head(t.attachmentKey)).not.toBeNull();

    const ledger = new ErasureLedger({ db, filePath: ledgerFile });
    const purger = new TenantPurger({ db, storage, ledger, alerts });
    const report = await purger.run(t.companyId, "operator-1");

    // Rows: nothing but the retained statements, found independently of the code that deleted.
    const left = await rowsLeft(t.companyId);
    expect(Object.keys(left).sort()).toEqual(Object.keys(RETAINED_TABLES).sort());
    expect(left.TenantStatement).toBe(1);
    expect(report.rows.Message).toBe(1);
    expect(report.rows.LlmCall).toBe(1);
    expect(report.auditRows).toBeGreaterThanOrEqual(2);

    // Bytes: the tenant's prefix and its exports are empty.
    expect(await storage.head(t.attachmentKey)).toBeNull();
    expect(await storage.listPrefixes(t.companyId)).toEqual([]);
    expect(await storage.listPrefixes(`exports/${t.companyId}`)).toEqual([]);

    // The sign-in tokens of its users went with it; platform rows were not touched.
    expect(await db.verificationToken.count({ where: { identifier: t.userEmail } })).toBe(0);
    expect(await db.provider.count({ where: { id: t.platformProviderId } })).toBe(1);

    // The tombstone, the ledger, the announcement.
    const company = await db.company.findUniqueOrThrow({ where: { id: t.companyId } });
    expect(company.status).toBe("deleted");
    expect(company.name).not.toBe(t.name);
    expect(await db.erasureLedger.count({ where: { kind: "tenant", targetId: t.companyId } })).toBe(1);
    const file = (await readFile(ledgerFile, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(file.at(-1)).toMatchObject({ kind: "tenant", targetId: t.companyId });
    // Ids only: no name, no address, no count of anything.
    expect(Object.keys(file.at(-1) ?? {}).sort()).toEqual([
      "erasedAt",
      "kind",
      "requestedBy",
      "targetId",
      "tenantRef",
    ]);
    expect(alerts.raised.some((a) => a.kind === "tenant.offboarded")).toBe(true);

    // Running it again is harmless.
    const again = await purger.run(t.companyId, "operator-1");
    expect(again.alreadyDeleted).toBe(true);
    expect(Object.keys(await rowsLeft(t.companyId)).sort()).toEqual(Object.keys(RETAINED_TABLES).sort());
  });

  it("the audit purge refuses a tenant that is not offboarding", async () => {
    const t = await seedTenant();
    await db.company.update({ where: { id: t.companyId }, data: { status: "active" } });
    await expect(db.$queryRawUnsafe(`SELECT audit_purge_tenant($1)`, t.companyId)).rejects.toThrow(
      /not offboarding/,
    );
    expect(await db.auditLog.count({ where: { companyId: t.companyId } })).toBe(2);
    // And an ordinary delete is still refused by the table's own guard.
    await expect(db.auditLog.deleteMany({ where: { companyId: t.companyId } })).rejects.toThrow(
      /append-only/,
    );
  });

  it("fails loudly when a row survives, instead of reporting success", async () => {
    const t = await seedTenant();
    const ledger = new ErasureLedger({ db });
    // A storage that cannot delete is not what is under test; a row that reappears is. Insert a
    // user from another connection while the purge is mid-flight by wrapping the ledger call.
    let late = true;
    const purger = new TenantPurger({
      db,
      storage,
      ledger,
      beforeScan: async (id) => {
        if (!late) return;
        await db.user.create({ data: { companyId: id, email: `late-${Date.now()}@x.test`, role: "member" } });
      },
    });
    await expect(purger.run(t.companyId, "op")).rejects.toBeInstanceOf(PurgeIncompleteError);
    // Not recorded as erased, and the company is not marked deleted: the next run finishes it.
    expect((await db.company.findUniqueOrThrow({ where: { id: t.companyId } })).status).toBe("offboarding");
    expect(await db.erasureLedger.count({ where: { targetId: t.companyId } })).toBe(0);
    late = false;
    await purger.run(t.companyId, "op");
    expect((await db.company.findUniqueOrThrow({ where: { id: t.companyId } })).status).toBe("deleted");
  });

  it("re-applies a recorded erasure when a restore brought the tenant back", async () => {
    const t = await seedTenant();
    const file = join(dir, "restore.jsonl");
    const ledger = new ErasureLedger({ db, filePath: file });
    // The erasure happened after the backup: the file says so, the restored database does not.
    await ledger.record({ kind: "tenant", targetId: t.companyId, tenantRef: t.companyId });
    await db.erasureLedger.deleteMany({ where: { targetId: t.companyId } });

    const jobs = new MemoryJobPublisher();
    const done = await reapplyErasures({ db, ledger, jobs });
    expect(done.tenants).toContain(t.companyId);
    expect(jobs.published.filter((j) => j.name === "tenant.offboard")).toEqual([
      expect.objectContaining({ payload: { companyId: t.companyId, requestedBy: "erasure-ledger" } }),
    ]);

    // Once it has run, a second pass finds nothing to do.
    await new TenantPurger({ db, storage, ledger: new ErasureLedger({ db }) }).run(
      t.companyId,
      "erasure-ledger",
    );
    const jobs2 = new MemoryJobPublisher();
    expect((await reapplyErasures({ db, ledger, jobs: jobs2 })).tenants).not.toContain(t.companyId);
  });

  it("finds a table added later without a hand-kept list", async () => {
    const { ordered } = await tenantTables(db);
    expect(ordered).toContain("Message");
    expect(ordered).toContain("FallbackRoute");
    // Children come before parents: a Message goes before its Session, and Session before Campaign.
    expect(ordered.indexOf("Message")).toBeLessThan(ordered.indexOf("Session"));
    expect(ordered.indexOf("Session")).toBeLessThan(ordered.indexOf("Campaign"));
  });
});

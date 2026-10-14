import { createCipheriv, randomBytes } from "node:crypto";
import { describeDb } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Crypto } from "../src/crypto.js";
import { ENCRYPTED_COLUMNS, keyUsage, NOT_REKEYABLE, rekeyAll } from "../src/keys/rekey.js";
import { openHeaders, sealHeaders } from "../src/providers/headers.js";
import { decryptApiKey } from "../src/providers/prisma-sources.js";
import { SettingsService } from "../src/settings/service.js";

const newKey = (): string => randomBytes(32).toString("base64");

function legacyV1(base64Key: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(base64Key, "base64"), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

/**
 * Key rotation against a real database (P9, D-164): the drill an operator runs, as a test.
 *
 *  1. a deployment holds secrets sealed under key A, some in the old v1 format;
 *  2. key B becomes active with A as previous: everything still reads, nothing is written under A;
 *  3. the rekey job moves every value to B, idempotently, and a concurrent edit wins;
 *  4. the status says A can be removed, and with A removed everything still reads.
 *
 * The inventory scan is the guard that a new encrypted column cannot be forgotten.
 */
describeDb("key rotation", () => {
  const db = new PrismaClient();
  const keyA = newKey();
  const keyB = newKey();
  const a = new Crypto(keyA);
  let companyId = "";
  let campaignId = "";
  const providerIds: string[] = [];

  beforeAll(async () => {
    const tag = randomBytes(4).toString("hex");
    companyId = (await db.company.create({ data: { name: `Rekey ${tag}` } })).id;
    const user = await db.user.create({
      data: { companyId, email: `rekey-${tag}@t.io`, role: "admin" },
    });
    const template = await db.interviewTemplate.create({
      data: { companyId, key: `k-${tag}`, name: "T", objective: "o", privacyMode: "anonymous" },
    });
    campaignId = (
      await db.campaign.create({
        data: {
          companyId,
          templateId: template.id,
          name: "C",
          participationMode: "anonymous",
          linkTokenHash: `rk-${tag}`,
          createdById: user.id,
        },
      })
    ).id;
  });

  async function seed(): Promise<void> {
    await db.provider.deleteMany({ where: { companyId } });
    await db.setting.deleteMany({ where: { scopeId: { in: [companyId, campaignId] } } });
    providerIds.length = 0;
    const seeds: { apiKeyEnc: string; headersEnc: string }[] = [
      // a v1 key and v1 headers: the oldest format in the field
      {
        apiKeyEnc: legacyV1(keyA, "sk-one"),
        headersEnc: legacyV1(keyA, JSON.stringify({ "x-gateway-key": "g-one" })),
      },
      // v2 under A, with purposes
      {
        apiKeyEnc: a.encrypt("sk-two", "provider.apiKey"),
        headersEnc: sealHeaders(a, { "x-team": "two" }),
      },
      // keyless provider: empty means "no key", not a ciphertext
      { apiKeyEnc: "", headersEnc: "" },
    ];
    for (const s of seeds) {
      const p = await db.provider.create({
        data: { companyId, kind: "openai_compatible", name: `p-${randomBytes(3).toString("hex")}`, ...s },
      });
      providerIds.push(p.id);
    }
    await db.setting.create({
      data: {
        scope: "tenant",
        scopeId: companyId,
        key: "email.smtpUrl",
        value: a.encrypt("smtp://user:pw@mail.example:587", "setting.secret"),
      },
    });
    await db.setting.create({
      data: {
        scope: "campaign",
        scopeId: campaignId,
        key: "_linkToken",
        value: a.encrypt("link-token-123", "campaign.linkToken"),
      },
    });
  }

  beforeEach(seed);
  afterAll(async () => {
    await db.provider.deleteMany({ where: { companyId } });
    await db.setting.deleteMany({ where: { scopeId: { in: [companyId, campaignId] } } });
    await db.$disconnect();
  });

  it("reads everything under the ring, writes under the active key, and reports what is left", async () => {
    const b = new Crypto(keyB, [keyA]);
    const before = await keyUsage(db, b);
    const apiKeys = before.columns.find((c) => c.column === "apiKeyEnc") as { byKey: Record<string, number> };
    expect(apiKeys.byKey.v1).toBeGreaterThanOrEqual(1);
    expect(apiKeys.byKey[a.activeKeyId]).toBeGreaterThanOrEqual(1);
    expect(apiKeys.byKey[b.activeKeyId] ?? 0).toBe(0);
    expect(before.pending).toBeGreaterThanOrEqual(5);
    expect(before.previousKeysRemovable).toBe(false);
    expect(before.ring).toEqual([
      { id: b.activeKeyId, active: true },
      { id: a.activeKeyId, active: false },
    ]);

    // Still readable by the application's own readers while the ring has both.
    const rows = await db.provider.findMany({ where: { id: { in: providerIds } }, orderBy: { id: "asc" } });
    const keys = rows.map((r) => decryptApiKey(b, r.apiKeyEnc)).sort();
    expect(keys).toEqual(["", "sk-one", "sk-two"]);
  });

  it("moves every stored secret to the active key, and a second run has nothing to do", async () => {
    const b = new Crypto(keyB, [keyA]);
    const first = await rekeyAll(db, b);
    expect(first.rekeyed).toBeGreaterThanOrEqual(6); // 2 api keys, 2 headers, 1 smtp, 1 link token
    // Rows other suites left in a shared database, sealed under keys that are not in this ring,
    // are counted and left alone; only this seed's rows are asserted on below.
    expect(first.conflicts).toBe(0);

    const second = await rekeyAll(db, b);
    expect(second.rekeyed).toBe(0);
    expect(second.alreadyCurrent).toBeGreaterThanOrEqual(6);

    const usage = await keyUsage(db, b);
    // This test's rows are all current; other suites' rows in a shared database may not be, so the
    // assertion is about what this seed created.
    const rows = await db.provider.findMany({ where: { id: { in: providerIds } } });
    for (const r of rows) {
      if (r.apiKeyEnc !== "") expect(b.isCurrent(r.apiKeyEnc)).toBe(true);
      if (r.headersEnc !== "") expect(b.isCurrent(r.headersEnc)).toBe(true);
    }
    expect(usage.ring[0]?.active).toBe(true);

    // Previous key removed: the application's readers still open everything.
    const onlyB = new Crypto(keyB);
    const after = await db.provider.findMany({ where: { id: { in: providerIds } } });
    expect(after.map((r) => decryptApiKey(onlyB, r.apiKeyEnc)).sort()).toEqual(["", "sk-one", "sk-two"]);
    const headers = after.map((r) => openHeaders(onlyB, r.headersEnc, {}));
    expect(headers).toEqual(expect.arrayContaining([{ "x-gateway-key": "g-one" }, { "x-team": "two" }, {}]));
    const smtp = await new SettingsService(db, onlyB).get("email.smtpUrl", [
      { scope: "tenant", scopeId: companyId },
    ]);
    expect(smtp).toBe("smtp://user:pw@mail.example:587");
    const link = await db.setting.findFirstOrThrow({ where: { scopeId: campaignId, key: "_linkToken" } });
    expect(onlyB.decrypt(link.value as string, "campaign.linkToken")).toBe("link-token-123");
  });

  it("lets a concurrent edit win and finishes the rest on the next run (compare-and-swap)", async () => {
    const target = providerIds[1]!;
    const b = new Crypto(keyB, [keyA]);
    const edited = b.encrypt("sk-edited", "provider.apiKey");

    // The admin saves a new key between the job's read of the old value and its write.
    const first = await rekeyAll(db, b, {
      beforeSwap: async (cell) => {
        if (cell.table === "Provider" && cell.id === target) {
          await db.provider.update({ where: { id: target }, data: { apiKeyEnc: edited } });
        }
      },
    });
    expect(first.conflicts).toBe(1);
    // The edit is what is stored: the job did not write its stale re-encryption over it.
    const row = await db.provider.findUniqueOrThrow({ where: { id: target } });
    expect(row.apiKeyEnc).toBe(edited);
    expect(b.decrypt(row.apiKeyEnc, "provider.apiKey")).toBe("sk-edited");

    // The next run has nothing left to move for that row and no conflicts.
    const second = await rekeyAll(db, b);
    expect(second.conflicts).toBe(0);
    expect(second.rekeyed).toBe(0);
  });

  it("never overwrites a value no key in the ring opens, and counts it", async () => {
    const stranger = new Crypto(newKey()).encrypt("not-ours", "provider.apiKey");
    await db.provider.update({ where: { id: providerIds[1]! }, data: { apiKeyEnc: stranger } });
    const b = new Crypto(keyB, [keyA]);
    const result = await rekeyAll(db, b);
    expect(result.unreadable).toBeGreaterThanOrEqual(1);
    expect((await db.provider.findUniqueOrThrow({ where: { id: providerIds[1]! } })).apiKeyEnc).toBe(
      stranger,
    );
    const usage = await keyUsage(db, b);
    const apiKeys = usage.columns.find((c) => c.column === "apiKeyEnc") as { byKey: Record<string, number> };
    expect(Object.keys(apiKeys.byKey).some((k) => k !== "v1" && !b.keyIds.includes(k))).toBe(true);
    expect(usage.previousKeysRemovable).toBe(false);
  });

  it("is inventoried: every column that holds platform-key ciphertext is in the rekey list", async () => {
    // Every text and JSON column of every table, read from information_schema, scanned for the
    // ciphertext shape. A column found holding it that is on neither list fails with its name.
    const columns = await db.$queryRaw<{ t: string; c: string; type: string }[]>`
      SELECT table_name AS t, column_name AS c, data_type AS type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type IN ('text', 'jsonb', 'json', 'character varying')`;
    const shape = String.raw`^"?(v[0-9]+|r[0-9]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`;
    const known = new Set([
      ...ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`),
      ...NOT_REKEYABLE.map((c) => `${c.table}.${c.column}`),
    ]);
    const found: string[] = [];
    for (const { t, c } of columns) {
      const [row] = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${t}" WHERE "${c}"::text ~ $1`,
        shape,
      );
      if (row && row.n > 0n && !known.has(`${t}.${c}`)) found.push(`${t}.${c}`);
    }
    expect(
      found,
      `These columns hold ciphertext but are not in ENCRYPTED_COLUMNS or NOT_REKEYABLE ` +
        `(packages/core/src/keys/rekey.ts), so a key rotation would strand them: ${found.join(", ")}`,
    ).toEqual([]);

    // Prove the scan can fail: a ciphertext planted in an unlisted column is found.
    const planted = a.encrypt("planted", "generic");
    const leaked = await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE "Company" SET name = $1 WHERE id = $2`, planted, companyId);
        const [row] = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "Company" WHERE name::text ~ $1`,
          shape,
        );
        throw Object.assign(new Error("rollback"), { n: row?.n ?? 0n });
      })
      .catch((e: unknown) => (e as { n?: bigint }).n ?? 0n);
    expect(leaked > 0n).toBe(true);
  });
});

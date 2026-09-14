import { randomBytes } from "node:crypto";
import { SECRET_SENTINEL } from "@aidp/shared";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crypto } from "../src/crypto.js";
import { SettingsService } from "../src/settings/service.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite("SettingsService", () => {
  const db = new PrismaClient();
  const crypto = new Crypto(randomBytes(32).toString("base64"));
  const svc = new SettingsService(db, crypto);
  const tenant = `t_${Date.now()}`;
  const campaign = `c_${Date.now()}`;
  const keys = ["campaign.linkExpiryDays", "email.smtpUrl", "email.from"];

  const cleanup = () =>
    db.setting.deleteMany({
      where: { OR: [{ scope: "platform", key: { in: keys } }, { scopeId: { in: [tenant, campaign] } }] },
    });

  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("resolves campaign > tenant > platform > default and validates writes", async () => {
    const chain = [
      { scope: "campaign" as const, scopeId: campaign },
      { scope: "tenant" as const, scopeId: tenant },
    ];
    expect(await svc.get("campaign.linkExpiryDays", chain)).toBe(30);
    await svc.set({ scope: "platform", scopeId: "" }, { "campaign.linkExpiryDays": 45 }, null);
    expect(await svc.get("campaign.linkExpiryDays", chain)).toBe(45);
    await svc.set({ scope: "tenant", scopeId: tenant }, { "campaign.linkExpiryDays": 20 }, "u1");
    expect(await svc.get("campaign.linkExpiryDays", chain)).toBe(20);
    await svc.set({ scope: "campaign", scopeId: campaign }, { "campaign.linkExpiryDays": 7 }, "u1");
    expect(await svc.get("campaign.linkExpiryDays", chain)).toBe(7);
    await svc.set({ scope: "campaign", scopeId: campaign }, { "campaign.linkExpiryDays": null }, "u1");
    expect(await svc.get("campaign.linkExpiryDays", chain)).toBe(20);
    await expect(
      svc.set({ scope: "campaign", scopeId: campaign }, { "privacy.kAnonymity": 2 }, "u1"),
    ).rejects.toThrow(/cannot be set/);
    await expect(
      svc.set({ scope: "tenant", scopeId: tenant }, { "campaign.linkExpiryDays": 9999 }, "u1"),
    ).rejects.toThrow();
  });

  it("rolls a rejected batch back instead of leaving half of it written", async () => {
    const ref = { scope: "tenant" as const, scopeId: tenant };
    const before = await svc.get("privacy.kAnonymity", [ref]);
    await expect(
      svc.set(ref, { "privacy.kAnonymity": 9, "privacy.retentionMonths": 9999 }, "u1"),
    ).rejects.toThrow();
    expect(await svc.get("privacy.kAnonymity", [ref])).toBe(before);
  });

  it("stores a secret encrypted, hides it behind the sentinel and clears it with null", async () => {
    const ref = { scope: "tenant" as const, scopeId: tenant };
    await svc.set(ref, { "email.smtpUrl": "smtp://user:pass@mail.test:587" }, "u1");

    const row = await db.setting.findFirstOrThrow({ where: { ...ref, key: "email.smtpUrl" } });
    expect(row.value).not.toContain("pass");
    expect(crypto.decrypt(row.value as string)).toBe("smtp://user:pass@mail.test:587");

    // The server-side read decrypts; the admin editor only ever sees the sentinel.
    expect(await svc.get("email.smtpUrl", [ref])).toBe("smtp://user:pass@mail.test:587");
    const described = await svc.describeAt(ref);
    expect(described.values["email.smtpUrl"]).toBe(SECRET_SENTINEL);
    expect(described.secrets["email.smtpUrl"]).toBe(true);

    // The sentinel on a write means "leave it alone".
    await svc.set(ref, { "email.smtpUrl": SECRET_SENTINEL, "email.from": "a@b.test" }, "u1");
    expect(await svc.get("email.smtpUrl", [ref])).toBe("smtp://user:pass@mail.test:587");
    expect(await svc.get("email.from", [ref])).toBe("a@b.test");

    await svc.set(ref, { "email.smtpUrl": null }, "u1");
    expect(await svc.get("email.smtpUrl", [ref])).toBe("");
    expect((await svc.describeAt(ref)).secrets["email.smtpUrl"]).toBe(false);
  });

  it("treats a secret it cannot decrypt as unset and warns", async () => {
    const ref = { scope: "tenant" as const, scopeId: tenant };
    await svc.set(ref, { "email.smtpUrl": "smtp://rotated@mail.test" }, "u1");
    const warnings: string[] = [];
    const other = new SettingsService(db, new Crypto(randomBytes(32).toString("base64")), {
      warn: (m) => warnings.push(m),
    });
    expect(await other.get("email.smtpUrl", [ref])).toBe("");
    expect((await other.describeAt(ref)).secrets["email.smtpUrl"]).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    await svc.set(ref, { "email.smtpUrl": null }, "u1");
  });
});

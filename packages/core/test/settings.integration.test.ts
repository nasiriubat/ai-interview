import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SettingsService } from "../src/settings/service.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite("SettingsService", () => {
  const db = new PrismaClient();
  const svc = new SettingsService(db);
  const tenant = `t_${Date.now()}`;
  const campaign = `c_${Date.now()}`;

  beforeAll(async () => {
    await db.setting.deleteMany({
      where: {
        OR: [{ scope: "platform", key: "campaign.linkExpiryDays" }, { scopeId: { in: [tenant, campaign] } }],
      },
    });
  });
  afterAll(async () => {
    await db.setting.deleteMany({
      where: {
        OR: [{ scope: "platform", key: "campaign.linkExpiryDays" }, { scopeId: { in: [tenant, campaign] } }],
      },
    });
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
});

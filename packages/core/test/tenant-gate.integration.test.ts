import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crypto } from "../src/crypto.js";
import { MemoryEmail } from "../src/email/port.js";
import { SettingsEmail } from "../src/email/settings-email.js";
import { SettingsService } from "../src/settings/service.js";
import { TenantGate, TenantSuspendedError } from "../src/tenancy/gate.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite("TenantGate (S8, D-86)", () => {
  const db = new PrismaClient();
  let companyId = "";

  beforeAll(async () => {
    companyId = (await db.company.create({ data: { name: `Gate ${randomBytes(4).toString("hex")}` } })).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("reflects the tenant's status, caches it briefly, and honours an explicit invalidate", async () => {
    let now = 1_000_000;
    const gate = new TenantGate(db, { ttlMs: 15_000, now: () => now });
    expect(await gate.state(companyId)).toBe("active");

    await db.company.update({ where: { id: companyId }, data: { status: "suspended" } });
    // Still cached: a suspension reaches another process within the TTL, not instantly.
    expect(await gate.isActive(companyId)).toBe(true);
    now += 14_000;
    expect(await gate.isActive(companyId)).toBe(true);
    now += 2_000;
    expect(await gate.isActive(companyId)).toBe(false);
    expect(await gate.state(companyId)).toBe("suspended");
    await expect(gate.assertActive(companyId)).rejects.toBeInstanceOf(TenantSuspendedError);

    await db.company.update({ where: { id: companyId }, data: { status: "active" } });
    gate.invalidate(companyId);
    expect(await gate.isActive(companyId)).toBe(true);
    await expect(gate.assertActive(companyId)).resolves.toBeUndefined();
  });

  it("treats an unknown tenant as not active", async () => {
    const gate = new TenantGate(db);
    expect(await gate.state("no-such-company")).toBe("missing");
    expect(await gate.isActive("no-such-company")).toBe(false);
  });

  it("stops outgoing email for a suspended tenant, and only that tenant", async () => {
    const other = (
      await db.company.create({ data: { name: `Gate other ${randomBytes(4).toString("hex")}` } })
    ).id;
    const settings = new SettingsService(db, new Crypto(randomBytes(32).toString("base64")));
    const fallback = new MemoryEmail();
    const gate = new TenantGate(db, { ttlMs: 0 });
    const email = new SettingsEmail({
      settings,
      env: { from: "env@test.io" },
      fallback,
      gate,
    });

    await db.company.update({ where: { id: companyId }, data: { status: "suspended" } });
    try {
      await expect(email.send({ to: "a@b.test", subject: "s", text: "t", companyId })).rejects.toBeInstanceOf(
        TenantSuspendedError,
      );
      expect(fallback.sent).toHaveLength(0);

      // Another tenant, and a platform message with no tenant, are unaffected.
      await email.send({ to: "a@b.test", subject: "s", text: "t", companyId: other });
      await email.send({ to: "a@b.test", subject: "s", text: "t" });
      expect(fallback.sent).toHaveLength(2);
    } finally {
      await db.company.update({ where: { id: companyId }, data: { status: "active" } });
    }
  });
});

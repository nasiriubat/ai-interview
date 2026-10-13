import type { Server } from "node:http";
import { SettingsService } from "@aidp/core";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * "Test connection" goes through ModelCaller as purpose `probe` (D-106): it is priced from the
 * tenant's table, ledgered, audited, capped per day, exempt from budgets, and cannot be aimed at a
 * provider the tenant may not use.
 */
describeDb("provider test through ModelCaller", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let providerId = "";

  const admin = () => ({ authorization: `Bearer ${world.adminToken}` });
  const test = (id = providerId) =>
    world.app.inject({ method: "POST", url: `/api/v1/providers/${id}/test`, headers: admin() });
  const probes = () => world.db.llmCall.findMany({ where: { companyId: world.companyId, purpose: "probe" } });

  beforeAll(async () => {
    model = await fakeModelServer(() => "ready");
    world = await testWorld(model.url);
    providerId = (
      await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId, name: "fake" } })
    ).id;
  });
  beforeEach(async () => {
    await world.db.llmCall.deleteMany({ where: { companyId: world.companyId, purpose: "probe" } });
    await world.db.setting.deleteMany({ where: { key: "cost.probeMaxPerDay" } });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  it("writes exactly one priced probe row, carries the provider as its reference, and is audited", async () => {
    const res = await test();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, model: "fake-model" });
    const rows = await probes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ providerId, model: "fake-model", status: "ok", sessionId: null });
    expect(rows[0]!.costCents).toBeGreaterThan(0);
    const audited = await world.db.auditLog.findFirst({
      where: { companyId: world.companyId, action: "provider.test", targetId: providerId },
    });
    expect(audited?.diff).toMatchObject({ ok: true, model: "fake-model" });
  });

  it("is refused over the tenant's daily cap, and the refusal is a 429 rather than a provider failure", async () => {
    // Written with the owner connection: setup is not a request, so it carries no tenant context.
    await new SettingsService(world.db, world.crypto).set(
      { scope: "tenant", scopeId: world.companyId },
      { "cost.probeMaxPerDay": 2 },
      null,
    );

    expect((await test()).statusCode).toBe(200);
    expect((await test()).statusCode).toBe(200);
    const third = await test();

    expect(third.statusCode).toBe(429);
    expect(await probes()).toHaveLength(2);
  });

  it("still works when the tenant's budget is spent, because a probe is not a budgeted call", async () => {
    await world.db.budget.updateMany({ where: { companyId: world.companyId }, data: { limitCents: 0 } });
    try {
      const res = await test();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true });
    } finally {
      await world.db.budget.updateMany({
        where: { companyId: world.companyId },
        data: { limitCents: 100_000 },
      });
    }
  });

  it("cannot be aimed at another tenant's provider", async () => {
    const other = await world.db.company.create({ data: { name: `Other ${Date.now()}` } });
    const foreign = await world.db.provider.create({
      data: {
        companyId: other.id,
        kind: "openai_compatible",
        name: "theirs",
        baseUrl: model.url,
        apiKeyEnc: world.crypto.encrypt("k"),
      },
    });
    try {
      const res = await test(foreign.id);

      expect(res.statusCode).toBe(404);
      expect(await world.db.llmCall.count({ where: { providerId: foreign.id } })).toBe(0);
    } finally {
      await world.db.provider.delete({ where: { id: foreign.id } });
      await world.db.company.delete({ where: { id: other.id } });
    }
  });

  it("reports a failing provider as ok: false, and still ledgers the attempt as an error", async () => {
    await world.db.provider.update({ where: { id: providerId }, data: { baseUrl: "http://127.0.0.1:9/v1" } });
    world.ctx.callers.invalidateProvider(providerId);
    try {
      const res = await test();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: false });
      const rows = await probes();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "error" });
    } finally {
      await world.db.provider.update({ where: { id: providerId }, data: { baseUrl: model.url } });
      world.ctx.callers.invalidateProvider(providerId);
    }
  });
});

import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * Platform rows under the policies of migration 0017 (D-141). The application runs as `app_api`
 * in these suites, so what is asserted here is what production does.
 */
describeDb("platform rows behind row-level security", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let platformProviderId = "";

  const admin = () => ({ authorization: `Bearer ${world.adminToken}` });
  const operator = () => ({ authorization: `Bearer ${world.operatorToken}` });

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url);
    platformProviderId = (
      await world.db.provider.create({
        data: {
          companyId: null,
          kind: "openai_compatible",
          name: `platform ${Date.now()}`,
          baseUrl: model.url,
          apiKeyEnc: world.crypto.encrypt("k", "provider.apiKey"),
        },
      })
    ).id;
  });
  afterAll(async () => {
    await world.db.provider.delete({ where: { id: platformProviderId } });
    await world.close();
    model.server.close();
  });

  it("lets a tenant admin list a platform provider's models without importing prices onto it", async () => {
    const res = await world.app.inject({
      method: "GET",
      url: `/api/v1/providers/${platformProviderId}/models`,
      headers: admin(),
    });

    // The listing is the tenant's to see; the platform's price table is not the tenant's to write,
    // and the database now refuses it (this answered 500 before, from a row-level-security error).
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stale: false, importedPrices: 0 });
    expect(await world.db.modelPrice.count({ where: { providerId: platformProviderId } })).toBe(0);
  });

  it("lets the operator import prices on a platform provider, even when acting inside a tenant", async () => {
    const res = await world.app.inject({
      method: "GET",
      url: `/api/v1/operator/providers/${platformProviderId}/models`,
      headers: { ...operator(), "x-company-id": world.companyId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ importedPrices: 1 });
    const price = await world.db.modelPrice.findFirstOrThrow({ where: { providerId: platformProviderId } });
    expect(price.companyId).toBeNull();
  });

  it("lets the operator write a platform setting while pinned to a tenant, and a tenant admin cannot", async () => {
    const put = (headers: Record<string, string>) =>
      world.app.inject({
        method: "PUT",
        url: "/api/v1/settings?scope=platform",
        headers,
        payload: { values: { "campaign.linkExpiryDays": 31 } },
      });

    const denied = await put(admin());
    const allowed = await put({ ...operator(), "x-company-id": world.companyId });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    const row = await world.db.setting.findFirstOrThrow({
      where: { scope: "platform", key: "campaign.linkExpiryDays" },
    });
    expect(row.companyId).toBeNull();
    await world.db.setting.delete({ where: { id: row.id } });
  });

  it("lists every tenant for an operator who also named one", async () => {
    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/tenants?limit=100",
      headers: { ...operator(), "x-company-id": world.companyId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ tenants: unknown[] }>().tenants.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a tenant admin only its own company row", async () => {
    // GET /settings/scopes?scope=tenant lists companies for an operator and only the caller's for an admin.
    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/settings/scopes?scope=tenant",
      headers: admin(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ targets: { id: string }[] }>().targets.map((t) => t.id)).toEqual([world.companyId]);
  });
});

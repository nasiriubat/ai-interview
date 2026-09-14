import type { Server } from "node:http";
import { SECRET_SENTINEL } from "@aidp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite("admin configuration surface (contract 19)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let admin: { authorization: string };
  let operator: { authorization: string };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ready");
    world = await testWorld(model.url);
    admin = { authorization: `Bearer ${world.adminToken}` };
    operator = { authorization: `Bearer ${world.operatorToken}` };
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const settings = (values: Record<string, unknown>) =>
    world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: admin,
      payload: { values },
    });
  const readSettings = () =>
    world.app.inject({ method: "GET", url: "/api/v1/settings?scope=tenant", headers: admin });

  it("keeps a secret setting encrypted, behind the sentinel, and out of the audit log", async () => {
    const url = "smtp://user:sup3rsecret@mail.test:587";
    expect((await settings({ "email.smtpUrl": url })).statusCode).toBe(200);

    const row = await world.db.setting.findFirstOrThrow({
      where: { scope: "tenant", scopeId: world.companyId, key: "email.smtpUrl" },
    });
    expect(row.value).not.toContain("sup3rsecret");
    expect(world.crypto.decrypt(row.value as string)).toBe(url);

    const got = await readSettings();
    expect(got.body).not.toContain("sup3rsecret");
    const body = got.json<{
      values: Record<string, unknown>;
      secrets: Record<string, boolean>;
      effective: Record<string, unknown>;
    }>();
    expect(body.values["email.smtpUrl"]).toBe(SECRET_SENTINEL);
    expect(body.effective["email.smtpUrl"]).toBe(SECRET_SENTINEL);
    expect(body.secrets["email.smtpUrl"]).toBe(true);

    // The audit diff names the key and never carries the value.
    const entry = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "settings.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(entry.diff)).toContain("email.smtpUrl");
    expect(JSON.stringify(entry.diff)).not.toContain("sup3rsecret");

    // The sentinel leaves it as it is; another key in the same body still lands.
    await settings({ "email.smtpUrl": SECRET_SENTINEL, "email.from": "team@tenant.test" });
    expect(
      await world.ctx.settings.get("email.smtpUrl", [{ scope: "tenant", scopeId: world.companyId }]),
    ).toBe(url);
    expect((await readSettings()).json<{ values: Record<string, unknown> }>().values["email.from"]).toBe(
      "team@tenant.test",
    );

    // null clears it.
    await settings({ "email.smtpUrl": null });
    const cleared = (await readSettings()).json<{
      values: Record<string, unknown>;
      secrets: Record<string, boolean>;
    }>();
    expect(cleared.values["email.smtpUrl"]).toBeUndefined();
    expect(cleared.secrets["email.smtpUrl"]).toBe(false);
  });

  it("sends a test message with the configuration in effect and says which scope won", async () => {
    const before = world.email.sent.length;
    const env = await world.app.inject({
      method: "POST",
      url: "/api/v1/settings/email/test",
      headers: admin,
      payload: {},
    });
    expect(env.statusCode).toBe(200);
    expect(env.json()).toMatchObject({ ok: true, usedScope: "env" });
    expect(world.email.sent.at(-1)?.to).toBe(world.adminEmail);
    expect(world.email.sent.length).toBe(before + 1);

    await settings({ "email.smtpUrl": "smtp://user:tenantsecret@mail.test:587" });
    const tenant = await world.app.inject({
      method: "POST",
      url: "/api/v1/settings/email/test",
      headers: admin,
      payload: { scope: "tenant" },
    });
    expect(tenant.json()).toMatchObject({ ok: true, usedScope: "tenant" });
    expect(tenant.body).not.toContain("tenantsecret");
    const entry = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "settings.email_test" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(entry.diff)).not.toContain("tenantsecret");
    await settings({ "email.smtpUrl": null });
  });

  it("offers scope targets by name and refuses another tenant's campaign id", async () => {
    const campaign = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: admin,
      payload: { templateId: world.templateId, name: "Scope target", verification: "open" },
    });
    const mine = campaign.json<{ campaign: { id: string } }>().campaign.id;

    const targets = await world.app.inject({
      method: "GET",
      url: "/api/v1/settings/scopes?scope=campaign",
      headers: admin,
    });
    expect(targets.statusCode).toBe(200);
    const listed = targets.json<{ targets: { id: string; name: string; detail?: string }[] }>().targets;
    expect(listed.map((t) => t.id)).toContain(mine);
    expect(listed.find((t) => t.id === mine)?.detail).toBeTypeOf("string");

    const templates = await world.app.inject({
      method: "GET",
      url: "/api/v1/settings/scopes?scope=template",
      headers: admin,
    });
    expect(templates.json<{ targets: { id: string }[] }>().targets.map((t) => t.id)).toContain(
      world.templateId,
    );

    // An id from another tenant is not readable and not writable, even though it exists.
    const other = await world.db.company.create({ data: { name: `Other ${Date.now()}` } });
    const otherAdmin = await world.db.user.create({
      data: { companyId: other.id, email: `other-${Date.now()}@test.io`, role: "admin" },
    });
    const foreign = await world.db.campaign.create({
      data: {
        company: { connect: { id: other.id } },
        template: { connect: { id: world.templateId } },
        createdBy: { connect: { id: otherAdmin.id } },
        name: "Not yours",
        linkTokenHash: `h_${Date.now()}`,
        status: "draft",
        participationMode: "anonymous",
      },
    });
    const read = await world.app.inject({
      method: "GET",
      url: `/api/v1/settings?scope=campaign&scopeId=${foreign.id}`,
      headers: admin,
    });
    expect(read.statusCode).toBe(404);
    const write = await world.app.inject({
      method: "PUT",
      url: `/api/v1/settings?scope=campaign&scopeId=${foreign.id}`,
      headers: admin,
      payload: { values: { "campaign.maxTurns": 9 } },
    });
    expect(write.statusCode).toBe(404);
  });

  it("gives the platform operator provider and route twins that an admin may not touch", async () => {
    for (const url of ["/api/v1/operator/providers", "/api/v1/operator/routes"]) {
      expect((await world.app.inject({ method: "GET", url, headers: admin })).statusCode).toBe(403);
    }

    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/operator/providers",
      headers: operator,
      payload: {
        kind: "openai_compatible",
        name: "platform fake",
        baseUrl: model.url,
        apiKey: "k",
      },
    });
    expect(created.statusCode).toBe(201);
    const provider = created.json<{ provider: { id: string; companyId: string | null } }>().provider;
    expect(provider.companyId).toBeNull();

    const listed = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/providers",
      headers: operator,
    });
    expect(listed.json<{ providers: { id: string }[] }>().providers.map((p) => p.id)).toContain(provider.id);

    const routed = await world.app.inject({
      method: "PUT",
      url: "/api/v1/operator/routes",
      headers: operator,
      payload: {
        routes: [{ purpose: "interview_turn", providerId: provider.id, model: "fake-model" }],
      },
    });
    expect(routed.statusCode).toBe(200);
    const platformRoute = await world.db.route.findFirstOrThrow({
      where: { companyId: null, purpose: "interview_turn" },
    });
    expect(platformRoute.providerId).toBe(provider.id);

    // The test route works without a body: the route above names the model.
    const tested = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/providers/${provider.id}/test`,
      headers: operator,
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ ok: true, model: "fake-model" });

    const patched = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/operator/providers/${provider.id}`,
      headers: operator,
      payload: { name: "platform fake 2" },
    });
    expect(patched.json<{ provider: { name: string } }>().provider.name).toBe("platform fake 2");

    await world.db.route.deleteMany({ where: { companyId: null } });
    const removed = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/operator/providers/${provider.id}`,
      headers: operator,
    });
    expect(removed.statusCode).toBe(200);
  });

  it("imports prices without touching an admin override and degrades to stale when the provider is down", async () => {
    const provider = await world.db.provider.findFirstOrThrow({
      where: { companyId: world.companyId, name: "fake" },
    });
    await world.db.modelPrice.update({
      where: { providerId_model: { providerId: provider.id, model: "fake-model" } },
      data: { inputPerMtok: 42, outputPerMtok: 43, cachedInputPerMtok: 44, source: "admin" },
    });

    const models = await world.app.inject({
      method: "GET",
      url: `/api/v1/providers/${provider.id}/models`,
      headers: admin,
    });
    expect(models.statusCode).toBe(200);
    const live = models.json<{ models: { id: string }[]; stale: boolean; fetchedAt: string | null }>();
    expect(live.stale).toBe(false);
    expect(live.fetchedAt).toBeTruthy();
    expect(live.models.map((m) => m.id)).toContain("fake-model");
    const kept = await world.db.modelPrice.findUniqueOrThrow({
      where: { providerId_model: { providerId: provider.id, model: "fake-model" } },
    });
    expect(kept).toMatchObject({ inputPerMtok: 42, source: "admin" });

    // A provider that cannot be reached answers 200 from the stored prices.
    const dead = await world.db.provider.create({
      data: {
        companyId: world.companyId,
        kind: "openai_compatible",
        name: "dead",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKeyEnc: world.crypto.encrypt("k"),
        headers: {},
      },
    });
    await world.db.modelPrice.create({
      data: {
        providerId: dead.id,
        model: "stored-model",
        inputPerMtok: 3,
        cachedInputPerMtok: 1,
        outputPerMtok: 6,
        source: "provider",
      },
    });
    const stale = await world.app.inject({
      method: "GET",
      url: `/api/v1/providers/${dead.id}/models`,
      headers: admin,
    });
    expect(stale.statusCode).toBe(200);
    const body = stale.json<{
      models: { id: string; inputPerMtok?: number }[];
      importedPrices: number;
      stale: boolean;
      error?: string;
    }>();
    expect(body.stale).toBe(true);
    expect(body.importedPrices).toBe(0);
    expect(body.error).toBeTruthy();
    expect(body.models).toEqual([
      { id: "stored-model", name: "stored-model", inputPerMtok: 3, cachedInputPerMtok: 1, outputPerMtok: 6 },
    ]);

    // PUT keeps a partial price: cachedInputPerMtok falls back to inputPerMtok.
    const put = await world.app.inject({
      method: "PUT",
      url: `/api/v1/providers/${dead.id}/prices`,
      headers: admin,
      payload: { prices: [{ model: "stored-model", inputPerMtok: 9, outputPerMtok: 18 }] },
    });
    expect(put.statusCode).toBe(200);
    const written = await world.db.modelPrice.findUniqueOrThrow({
      where: { providerId_model: { providerId: dead.id, model: "stored-model" } },
    });
    expect(written).toMatchObject({ inputPerMtok: 9, cachedInputPerMtok: 9, source: "admin" });
  });

  it("windows a staff list and reports the total beside it", async () => {
    const suffix = Date.now().toString(36);
    for (let i = 0; i < 3; i++) {
      await world.db.user.create({
        data: { companyId: world.companyId, email: `page-${i}-${suffix}@test.io`, role: "member" },
      });
    }
    const total = await world.db.user.count({ where: { companyId: world.companyId } });

    const page = await world.app.inject({
      method: "GET",
      url: "/api/v1/users?limit=2&offset=1",
      headers: admin,
    });
    expect(page.statusCode).toBe(200);
    const body = page.json<{ users: { id: string }[]; total: number; limit: number; offset: number }>();
    expect(body.users).toHaveLength(2);
    expect(body).toMatchObject({ total, limit: 2, offset: 1 });

    const all = await world.app.inject({ method: "GET", url: "/api/v1/users", headers: admin });
    const every = all.json<{ users: { id: string }[] }>().users.map((u) => u.id);
    expect(body.users.map((u) => u.id)).toEqual(every.slice(1, 3));

    expect(
      (await world.app.inject({ method: "GET", url: "/api/v1/users?limit=0", headers: admin })).statusCode,
    ).toBe(400);
  });
});

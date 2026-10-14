import type { Server } from "node:http";
import { encryptLegacyProviderHeaders, openHeaders, PrismaProviderConfigSource } from "@aidp/core";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * Custom provider headers are credentials (D-147): encrypted at rest, returned as names only,
 * kept out of the audit log, and not shown to a tenant for a platform provider.
 */
describeDb("provider headers", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let platformProviderId = "";

  const admin = () => ({ authorization: `Bearer ${world.adminToken}` });
  const operator = () => ({ authorization: `Bearer ${world.operatorToken}` });
  const SECRET = "gw-secret-value-1f7c";

  const create = async (headers: Record<string, string>, name = `h-${Math.random()}`) =>
    world.app.inject({
      method: "POST",
      url: "/api/v1/providers",
      headers: admin(),
      payload: { kind: "openai_compatible", name, baseUrl: model.url, apiKey: "k", headers },
    });
  interface View {
    id: string;
    headerNames: string[];
  }

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
          headersEnc: world.crypto.encrypt(
            JSON.stringify({ "x-platform-gateway": "platform-secret" }),
            "provider.headers",
          ),
        },
      })
    ).id;
  });
  afterAll(async () => {
    await world.db.provider.delete({ where: { id: platformProviderId } });
    await world.close();
    model.server.close();
  });

  it("stores the headers encrypted and returns their names, never their values", async () => {
    const res = await create({ "x-api-key": SECRET, "x-team": "ward-7" });

    expect(res.statusCode).toBe(201);
    const { provider } = res.json<{ provider: View }>();
    expect(provider.headerNames).toEqual(["x-api-key", "x-team"]);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("ward-7");
    expect(res.json<{ provider: Record<string, unknown> }>().provider).not.toHaveProperty("headers");

    const row = await world.db.provider.findUniqueOrThrow({ where: { id: provider.id } });
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row.headers).toEqual({});
    expect(row.headersEnc).not.toBe("");
    expect(openHeaders(world.crypto, row.headersEnc, row.headers)).toEqual({
      "x-api-key": SECRET,
      "x-team": "ward-7",
    });

    const listed = await world.app.inject({ method: "GET", url: "/api/v1/providers", headers: admin() });
    expect(listed.body).not.toContain(SECRET);
    expect(listed.json<{ providers: View[] }>().providers.find((p) => p.id === provider.id)).toMatchObject({
      headerNames: ["x-api-key", "x-team"],
    });
  });

  it("uses the stored headers on the connection that a provider test makes", async () => {
    const { provider } = (await create({ "x-api-key": SECRET }, "wire")).json<{ provider: View }>();
    const seen: Record<string, string | string[] | undefined>[] = [];
    model.server.on("request", (req) => seen.push(req.headers));

    const res = await world.app.inject({
      method: "GET",
      url: `/api/v1/providers/${provider.id}/models`,
      headers: admin(),
    });

    expect(res.statusCode).toBe(200);
    expect(seen.some((h) => h["x-api-key"] === SECRET)).toBe(true);
  });

  it("replaces the map on update: __keep__ keeps a stored value, a new value replaces it, the rest go", async () => {
    const { provider } = (await create({ "x-api-key": SECRET, "x-team": "ward-7", "x-old": "gone" })).json<{
      provider: View;
    }>();

    const res = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/providers/${provider.id}`,
      headers: admin(),
      payload: { headers: { "X-Api-Key": "__keep__", "x-team": "ward-9", "x-new": "n" } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ provider: View }>().provider.headerNames).toEqual(["X-Api-Key", "x-new", "x-team"]);
    const row = await world.db.provider.findUniqueOrThrow({ where: { id: provider.id } });
    expect(openHeaders(world.crypto, row.headersEnc, row.headers)).toEqual({
      "X-Api-Key": SECRET,
      "x-team": "ward-9",
      "x-new": "n",
    });
  });

  it("refuses to keep a header that has no stored value, and a request that omits headers leaves them", async () => {
    const { provider } = (await create({ "x-api-key": SECRET })).json<{ provider: View }>();

    const bad = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/providers/${provider.id}`,
      headers: admin(),
      payload: { headers: { "x-unknown": "__keep__" } },
    });
    const rename = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/providers/${provider.id}`,
      headers: admin(),
      payload: { name: "renamed" },
    });

    expect(bad.statusCode).toBe(400);
    expect(rename.json<{ provider: View }>().provider.headerNames).toEqual(["x-api-key"]);
    const row = await world.db.provider.findUniqueOrThrow({ where: { id: provider.id } });
    expect(openHeaders(world.crypto, row.headersEnc, row.headers)).toEqual({ "x-api-key": SECRET });
  });

  it("writes names only to the audit log, on create and on update", async () => {
    const { provider } = (await create({ "x-api-key": SECRET })).json<{ provider: View }>();
    await world.app.inject({
      method: "PATCH",
      url: `/api/v1/providers/${provider.id}`,
      headers: admin(),
      payload: { headers: { "x-api-key": "rotated-secret-77" }, apiKey: "new-key-material" },
    });

    const rows = await world.db.auditLog.findMany({
      where: { companyId: world.companyId, targetId: provider.id },
    });

    expect(rows.map((r) => r.action).sort()).toEqual(["provider.create", "provider.update"]);
    const text = JSON.stringify(rows.map((r) => r.diff));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("rotated-secret-77");
    expect(text).not.toContain("new-key-material");
    expect(text).toContain("headerNames");
    expect(text).toContain("x-api-key");
  });

  it("refuses header names that would rewrite the request's framing or credentials", async () => {
    for (const name of ["authorization", "Host", "content-length", "x-forwarded-for", "cookie"]) {
      const res = await create({ [name]: "x" });
      expect(res.statusCode, name).toBe(422);
    }
  });

  it("does not show a tenant admin the header names of a platform provider, and shows the operator", async () => {
    const asAdmin = await world.app.inject({ method: "GET", url: "/api/v1/providers", headers: admin() });
    const asOperator = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/providers",
      headers: operator(),
    });

    const seenByAdmin = asAdmin
      .json<{ providers: View[] }>()
      .providers.find((p) => p.id === platformProviderId);
    const seenByOperator = asOperator
      .json<{ providers: View[] }>()
      .providers.find((p) => p.id === platformProviderId);
    expect(seenByAdmin).toMatchObject({ headerNames: [] });
    expect(asAdmin.body).not.toContain("x-platform-gateway");
    expect(asAdmin.body).not.toContain("platform-secret");
    expect(seenByOperator?.headerNames).toEqual(["x-platform-gateway"]);
    expect(asOperator.body).not.toContain("platform-secret");
  });

  describe("rows written before the encrypted column", () => {
    it("are encrypted by the backfill, once, and still work before it has run", async () => {
      const legacy = await world.db.provider.create({
        data: {
          companyId: world.companyId,
          kind: "openai_compatible",
          name: `legacy ${Date.now()}`,
          baseUrl: model.url,
          apiKeyEnc: world.crypto.encrypt("k", "provider.apiKey"),
          headers: { "x-api-key": "legacy-secret-9" },
        },
      });
      const source = new PrismaProviderConfigSource(world.db, world.crypto);
      expect((await source.get(world.companyId, legacy.id))?.headers).toEqual({
        "x-api-key": "legacy-secret-9",
      });

      const first = await encryptLegacyProviderHeaders(world.db, world.crypto);
      const second = await encryptLegacyProviderHeaders(world.db, world.crypto);

      expect(first).toBeGreaterThanOrEqual(1);
      expect(second).toBe(0);
      const row = await world.db.provider.findUniqueOrThrow({ where: { id: legacy.id } });
      expect(JSON.stringify(row)).not.toContain("legacy-secret-9");
      expect(row.headers).toEqual({});
      expect((await source.get(world.companyId, legacy.id))?.headers).toEqual({
        "x-api-key": "legacy-secret-9",
      });
    });
  });
});

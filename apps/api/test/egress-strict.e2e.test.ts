import { createServer, type Server } from "node:http";
import { EgressGuard, type Resolver } from "@aidp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * The strict outbound policy through the admin API (S4, D-83). The other e2e suites run the
 * permissive mode so a fake model server on loopback works; this one is about the policy itself,
 * with DNS replaced by a table so nothing depends on the network.
 */
suite("provider addresses under the strict egress policy", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let upstream: Server;
  let upstreamPort = 0;
  let upstreamHits = 0;
  const dns: Record<string, string[]> = {};

  const resolver: Resolver = async (name) => {
    const found = dns[name];
    if (!found) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

  beforeAll(async () => {
    upstream = createServer((_req, res) => {
      upstreamHits++;
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      // What a hostile or merely chatty upstream says. None of it may reach the admin.
      res.end(
        JSON.stringify({
          error: { message: "SECRET-UPSTREAM-BODY 10.1.2.3 internal", code: "invalid_api_key" },
        }),
      );
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const addr = upstream.address();
    upstreamPort = typeof addr === "object" && addr ? addr.port : 0;

    model = await fakeModelServer(() => "x");
    const egress = new EgressGuard({ mode: "strict", allowHosts: ["litellm"] }, { resolver });
    world = await testWorld(
      model.url,
      {
        EGRESS_MODE: "strict",
        EGRESS_ALLOW_HOSTS: "litellm",
        RATE_LIMIT_MAX: "100000",
        RATE_LIMIT_EXPENSIVE_MAX: "100000",
      },
      { egress },
    );
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
    upstream.close();
  });

  const admin = () => ({ authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" });
  const operator = () => ({
    authorization: `Bearer ${world.operatorToken}`,
    "content-type": "application/json",
  });
  const create = (headers: Record<string, string>, url: string, body: Record<string, unknown>) =>
    world.app.inject({
      method: "POST",
      url,
      headers,
      payload: { kind: "openai_compatible", name: "p", apiKey: "sk-test-123456", ...body },
    });

  describe("a tenant admin", () => {
    it.each([
      ["loopback", "http://127.0.0.1:9999/v1"],
      ["https loopback", "https://127.0.0.1/v1"],
      ["the metadata address", "https://169.254.169.254/latest"],
      ["a decimal loopback", "https://2130706433/v1"],
      ["an IPv6 loopback", "https://[::1]/v1"],
      ["localhost", "https://localhost/v1"],
      ["a compose service name", "https://postgres/v1"],
      ["http to a public name", "http://api.example.com/v1"],
    ])("cannot save a provider at %s", async (_n, baseUrl) => {
      const res = await create(admin(), "/api/v1/providers", { baseUrl });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: "blocked_address" } });
    });

    it("cannot save a name that resolves to a private address", async () => {
      dns["sneaky.example.com"] = ["10.0.0.9"];
      const res = await create(admin(), "/api/v1/providers", { baseUrl: "https://sneaky.example.com/v1" });
      expect(res.statusCode).toBe(422);
    });

    it("cannot save headers that replace the credential or the host", async () => {
      dns["api.example.com"] = ["93.184.216.34"];
      for (const headers of [
        { Authorization: "Bearer other" },
        { Host: "internal" },
        { "X-Forwarded-For": "1.2.3.4" },
      ]) {
        const res = await create(admin(), "/api/v1/providers", {
          baseUrl: "https://api.example.com/v1",
          headers,
        });
        expect(res.statusCode).toBe(422);
      }
    });

    it("can save an ordinary public https provider", async () => {
      dns["api.example.com"] = ["93.184.216.34"];
      const res = await create(admin(), "/api/v1/providers", {
        baseUrl: "https://api.example.com/v1",
        headers: { "x-team": "research" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("gets one coarse answer from a test of a legacy provider row, and the target is never contacted", async () => {
      // A row written before the rule, or by hand: the connect-time check is what stops it.
      const row = await world.db.provider.create({
        data: {
          companyId: world.companyId,
          kind: "openai_compatible",
          name: "legacy",
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKeyEnc: world.crypto.encrypt("k"),
          headers: {},
        },
      });
      upstreamHits = 0;
      const tested = await world.app.inject({
        method: "POST",
        url: `/api/v1/providers/${row.id}/test`,
        headers: admin(),
        payload: { model: "m" },
      });
      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({ ok: false, status: "blocked_address" });
      const models = await world.app.inject({
        method: "GET",
        url: `/api/v1/providers/${row.id}/models`,
        headers: admin(),
      });
      expect(models.json()).toMatchObject({ status: "blocked_address", stale: true });
      expect(upstreamHits).toBe(0);
    });
  });

  describe("the platform operator", () => {
    it("can point a platform provider at an allowlisted internal service", async () => {
      dns.litellm = ["127.0.0.1"];
      const res = await create(operator(), "/api/v1/operator/providers", {
        kind: "litellm",
        baseUrl: `http://litellm:${upstreamPort}/v1`,
      });
      expect(res.statusCode).toBe(201);
    });

    it("cannot use an internal host that is not on the allowlist, nor the metadata address", async () => {
      dns.stray = ["127.0.0.1"];
      expect(
        (await create(operator(), "/api/v1/operator/providers", { baseUrl: "http://stray:4000/v1" }))
          .statusCode,
      ).toBe(422);
      expect(
        (await create(operator(), "/api/v1/operator/providers", { baseUrl: "http://10.0.0.5/v1" }))
          .statusCode,
      ).toBe(422);
      dns.litellm = ["169.254.169.254"];
      expect(
        (await create(operator(), "/api/v1/operator/providers", { baseUrl: "http://litellm/v1" })).statusCode,
      ).toBe(422);
      dns.litellm = ["127.0.0.1"];
    });

    it("never gets an upstream response body back through test or models", async () => {
      dns.litellm = ["127.0.0.1"];
      const created = await create(operator(), "/api/v1/operator/providers", {
        kind: "litellm",
        baseUrl: `http://litellm:${upstreamPort}/v1`,
      });
      const id = created.json<{ provider: { id: string } }>().provider.id;
      upstreamHits = 0;

      const tested = await world.app.inject({
        method: "POST",
        url: `/api/v1/operator/providers/${id}/test`,
        headers: operator(),
        payload: { model: "m" },
      });
      expect(upstreamHits).toBeGreaterThan(0); // the allowlisted host was really contacted
      expect(tested.body).not.toContain("SECRET-UPSTREAM-BODY");
      expect(tested.body).not.toContain("10.1.2.3");
      expect(tested.json()).toMatchObject({ ok: false, status: "unauthorized" });

      const models = await world.app.inject({
        method: "GET",
        url: `/api/v1/operator/providers/${id}/models`,
        headers: operator(),
      });
      expect(models.body).not.toContain("SECRET-UPSTREAM-BODY");
      expect(models.json()).toMatchObject({ status: "unauthorized", stale: true });
    });
  });

  it("refuses a mail relay a tenant points at its own network", async () => {
    for (const url of [
      "smtp://127.0.0.1:587",
      "smtp://localhost:587",
      "smtp://mail.example.com:25",
      "smtp://db:587",
    ]) {
      const res = await world.app.inject({
        method: "PUT",
        url: "/api/v1/settings?scope=tenant",
        headers: admin(),
        payload: { values: { "email.smtpUrl": url } },
      });
      expect(res.statusCode, url).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: "blocked_address" } });
    }
    dns["mail.example.com"] = ["93.184.216.34"];
    const ok = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: admin(),
      payload: { values: { "email.smtpUrl": "smtps://user:pw@mail.example.com" } },
    });
    expect(ok.statusCode).toBe(200);
  });
});

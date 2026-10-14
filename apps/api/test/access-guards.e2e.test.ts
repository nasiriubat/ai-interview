import type { Server } from "node:http";
import { encode } from "@auth/core/jwt";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guard, installAccessGuard } from "../src/auth/access.js";
import { installAuditDeclarationCheck } from "../src/auth/audit-actions.js";
import { fakeModelServer, testWorld, TEST_AUTH_SECRET, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

describe("access declarations fail closed (S2)", () => {
  it("refuses to register a route that declares no access", async () => {
    const app = Fastify();
    installAccessGuard(app);
    expect(() => app.get("/undeclared", async () => ({ ok: true }))).toThrow(/declares no access/);
  });

  it("refuses to boot a staff mutation that declares no audit action (D-163)", () => {
    const app = Fastify();
    installAccessGuard(app);
    installAuditDeclarationCheck(app);
    // Reads need no declaration, and neither do participant or public mutations.
    expect(() => app.get("/things", { ...guard.admin() }, async () => ({}))).not.toThrow();
    expect(() => app.post("/open/thing", { ...guard.public() }, async () => ({}))).not.toThrow();
    expect(() => app.post("/p/thing", { ...guard.participant() }, async () => ({}))).not.toThrow();
    // A staff mutation does.
    expect(() => app.post("/things", { ...guard.admin() }, async () => ({}))).toThrow(
      /no audit declaration.*AUDIT_DECLARATIONS/,
    );
    expect(() => app.delete("/things/:id", { ...guard.operator() }, async () => ({}))).toThrow(
      /no audit declaration/,
    );
    expect(() => app.put("/members/:id", { ...guard.staff() }, async () => ({}))).toThrow(
      /no audit declaration/,
    );
    // And one that is declared is fine.
    expect(() => app.post("/users", { ...guard.admin() }, async () => ({}))).not.toThrow();
  });

  it("records every declared route in the route table", async () => {
    const app = Fastify();
    installAccessGuard(app);
    app.get("/open", { ...guard.public() }, async () => ({ ok: true }));
    app.post("/admin", { ...guard.admin() }, async () => ({ ok: true }));
    await app.ready();
    expect(app.routeTable).toEqual(
      expect.arrayContaining([
        { method: "GET", url: "/open", access: "public" },
        { method: "POST", url: "/admin", access: "admin" },
      ]),
    );
  });

  it("answers 401 for an anonymous caller before the body is parsed or validated", async () => {
    const app = Fastify();
    installAccessGuard(app);
    app.decorateRequest("principal");
    app.addHook("onRequest", async (req) => {
      req.principal = { kind: "anonymous" };
    });
    let parsed = false;
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      parsed = true;
      done(null, body);
    });
    app.post("/admin", { ...guard.admin() }, async () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/admin",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(401);
    expect(parsed).toBe(false);
  });
});

suite("every route is guarded before validation (S2)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    // The limiter is not what is under test, and a sweep of every route would trip it.
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const fill = (url: string): string => url.replace(/:[A-Za-z]+/g, "someid");

  it("declares an access level on every route the app serves", () => {
    const table = world.app.routeTable;
    expect(table.length).toBeGreaterThan(60);
    for (const r of table) {
      expect(["public", "participant", "staff", "admin", "operator", "internal"]).toContain(r.access);
    }
  });

  it("returns 401, not a validation error, to an anonymous caller on every protected route", async () => {
    const protectedRoutes = world.app.routeTable.filter(
      (r) => r.access !== "public" && r.method !== "HEAD" && r.method !== "OPTIONS",
    );
    expect(protectedRoutes.length).toBeGreaterThan(50);
    const failures: string[] = [];
    for (const r of protectedRoutes) {
      // A websocket upgrade is closed by its handler with a status, not answered with a 401.
      if (r.url.endsWith("/p/session/live")) continue;
      const res = await world.app.inject({
        method: r.method as "GET",
        url: fill(r.url),
        // A body no schema accepts, and which would be a 400 if it were looked at.
        ...(r.method === "GET" || r.method === "DELETE"
          ? {}
          : {
              headers: { "content-type": "application/json" },
              payload: JSON.stringify({ x: [1, 2, { y: 3 }] }),
            }),
      });
      if (res.statusCode !== 401) failures.push(`${r.method} ${r.url} -> ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });

  it("returns 401, not 400, for a malformed JSON body from an anonymous caller", async () => {
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { "content-type": "application/json" },
      payload: "{broken",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("returns 401 to a participant token on a staff route, and to a staff token on a participant route", async () => {
    const participantOnStaff = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { authorization: "Bearer pt.not-a-real-token", "content-type": "application/json" },
      payload: "{}",
    });
    expect(participantOnStaff.statusCode).toBe(401);
    const staffOnParticipant = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" },
      payload: "{}",
    });
    expect(staffOnParticipant.statusCode).toBe(401);
  });

  it("returns 403, before validation, to a member on an admin route", async () => {
    const email = `member-${Date.now().toString(36)}@test.io`;
    await world.db.user.create({ data: { companyId: world.companyId, email, role: "member" } });
    const token = await encode({
      token: { email },
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ not: "valid" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("still validates the body once the caller is allowed in", async () => {
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ not: "valid" }),
    });
    expect(res.statusCode).toBe(400);
  });
});

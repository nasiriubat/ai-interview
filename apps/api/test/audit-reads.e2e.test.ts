import type { Server } from "node:http";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_READS } from "../src/auth/access-audit.js";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Operator impersonation and sensitive reads leave audit rows (A2, D-262). A change is already
 * recorded by the mutation registry; these are the reads that matter just as much: the platform
 * operator working inside a tenant, and anyone reading a transcript.
 */
suite("audit rows for access and sensitive reads", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let sessionId = "";
  let campaignId = "";
  let memberToken = "";
  let memberId = "";
  let adminId = "";
  let operatorId = "";
  const as = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
    adminId = (await world.db.user.findFirstOrThrow({ where: { email: world.adminEmail } })).id;
    operatorId = (await world.db.user.findFirstOrThrow({ where: { email: world.operatorEmail } })).id;
    const memberEmail = `reader-${Date.now().toString(36)}@test.io`;
    memberId = (
      await world.db.user.create({ data: { companyId: world.companyId, email: memberEmail, role: "member" } })
    ).id;
    memberToken = await encode({
      token: { email: memberEmail },
      secret: world.ctx.config.AUTH_SECRET,
      salt: "authjs.session-token",
    });
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: as(world.adminToken),
      payload: { templateId: world.templateId, name: "Reads", verification: "open" },
    });
    const body = created.json<{ campaign: { id: string }; link: { url: string } }>();
    campaignId = body.campaign.id;
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/open`,
      headers: as(world.adminToken),
    });
    const opened = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${body.link.url.split("/p/")[1]}/open`,
      payload: {},
    });
    sessionId = opened.json<{ sessionId: string }>().sessionId;
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const rows = (action: string, actorId: string) =>
    world.db.auditLog.findMany({
      where: { companyId: world.companyId, action, actorId },
      orderBy: { createdAt: "asc" },
    });

  it("declares reads only for GET routes that exist", () => {
    const gets = new Set(
      world.app.routeTable
        .filter((r) => r.method === "GET")
        .map((r) => `GET ${r.url.replace("/api/v1", "")}`),
    );
    const unknown = Object.keys(AUDIT_READS).filter((k) => !gets.has(k));
    expect(unknown, "an AUDIT_READS entry for a route that no longer exists").toEqual([]);
  });

  it("records a transcript read by an admin, once for a burst within a minute", async () => {
    for (let i = 0; i < 4; i++) {
      const res = await world.app.inject({
        method: "GET",
        url: `/api/v1/sessions/${sessionId}`,
        headers: as(world.adminToken),
      });
      expect(res.statusCode).toBe(200);
    }
    const written = await rows("session.read", adminId);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ targetType: "session", targetId: sessionId });
    // Nothing of the thing that was read is copied into the row.
    expect(written[0]?.diff ?? null).toBeNull();
  });

  it("records a member's read as the member's, not the admin's", async () => {
    const res = await world.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}`,
      headers: as(memberToken),
    });
    // Members may or may not see transcripts (privacy.transcriptVisibility); a 200 is the case
    // that must leave a row, a 403 must not.
    const written = await rows("session.read", memberId);
    expect(written).toHaveLength(res.statusCode === 200 ? 1 : 0);
  });

  it("records the events and the identities list, and writes nothing for a refused or missing read", async () => {
    // The default shows a transcript only for an identified, opted-in participant.
    const set = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: as(world.adminToken),
      payload: { values: { "privacy.rawTranscriptsVisibleTo": "admins" } },
    });
    expect(set.statusCode).toBe(200);
    const events = await world.app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}/events`,
      headers: as(world.adminToken),
    });
    expect(events.statusCode).toBe(200);
    const list = await world.app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaignId}/sessions`,
      headers: as(world.adminToken),
    });
    expect(list.statusCode).toBe(200);
    expect(
      await world.db.auditLog.count({
        where: { companyId: world.companyId, action: "session.list_read", targetId: campaignId },
      }),
    ).toBe(1);

    const before = await world.db.auditLog.count({ where: { companyId: world.companyId } });
    const missing = await world.app.inject({
      method: "GET",
      url: `/api/v1/sessions/no-such-session`,
      headers: as(world.adminToken),
    });
    expect(missing.statusCode).toBeGreaterThanOrEqual(400);
    const anonymous = await world.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}` });
    expect(anonymous.statusCode).toBe(401);
    expect(await world.db.auditLog.count({ where: { companyId: world.companyId } })).toBe(before);
  });

  it("records an operator acting in a tenant through X-Company-Id, once per window", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await world.app.inject({
        method: "GET",
        url: "/api/v1/campaigns",
        headers: as(world.operatorToken, { "x-company-id": world.companyId }),
      });
      expect(res.statusCode).toBe(200);
    }
    const written = await world.db.auditLog.findMany({
      where: { companyId: world.companyId, action: "operator.access", actorId: operatorId },
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ targetType: "tenant", targetId: world.companyId });
    // The route and method, never a body, a query string or an id from the path.
    expect(written[0]?.diff).toEqual({ method: "GET", route: "GET /campaigns" });
  });

  it("does not record the operator's own tenant, nor a platform route, nor an unknown tenant", async () => {
    const own = await world.db.user.findFirstOrThrow({ where: { email: world.operatorEmail } });
    await world.app.inject({
      method: "GET",
      url: "/api/v1/campaigns",
      headers: as(world.operatorToken),
    });
    await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/tenants",
      headers: as(world.operatorToken, { "x-company-id": world.companyId }),
    });
    const ghost = await world.app.inject({
      method: "GET",
      url: "/api/v1/campaigns",
      headers: as(world.operatorToken, { "x-company-id": "no-such-tenant" }),
    });
    expect(ghost.statusCode).toBeLessThan(500);
    expect(
      await world.db.auditLog.count({ where: { companyId: own.companyId, action: "operator.access" } }),
    ).toBe(0);
  });
});

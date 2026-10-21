import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { BROWSER_REPORTS_PER_MINUTE } from "../src/modules/errors/routes.js";
import { fakeModelServer, TEST_INTERNAL_SECRET, testWorld, type TestWorld } from "./helpers.js";

/**
 * The built-in error log end to end (D-477): a 5xx is captured with its secrets removed and a 4xx
 * is not, browsers report through a tight public route, the web server through the internal one,
 * and only the platform operator reads the log, resolves a group or deletes one, each audited.
 */
describeDb("error log", () => {
  let world: TestWorld;
  let model: { server: Server; url: string };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const LINK = "Lk7Qx2Rv9Tz4Wb8Np3Hs6Jd";
  const tag = `errlog-${Date.now().toString(36)}`;

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await world.db.errorGroup.deleteMany({ where: { message: { contains: tag } } });
    await world.close();
    model.server.close();
  });

  const groups = (where: Record<string, unknown>) =>
    world.db.errorGroup.findMany({ where, include: { occurrences: true } });

  it("captures a 5xx with the route, the request and the tenant, and nothing secret", async () => {
    vi.spyOn(world.ctx.services.participant, "resolveLink").mockRejectedValueOnce(
      new Error(`${tag} link ${LINK} failed for jane.doe@example.com`),
    );
    const res = await world.app.inject({
      method: "GET",
      url: `/api/v1/p/${LINK}?email=jane.doe%40example.com&token=${LINK}`,
      headers: { cookie: "aidp_participant=secret-cookie", "user-agent": "Mozilla/5.0 test" },
    });
    expect(res.statusCode).toBe(500);
    await world.ctx.errors.flush();

    const [group] = await groups({ message: { contains: tag }, source: "api" });
    expect(group).toMatchObject({
      source: "api",
      severity: "error",
      route: "/api/v1/p/:linkToken",
      count: 1,
    });
    const o = group!.occurrences[0]!;
    expect(o).toMatchObject({ method: "GET", status: 500, userAgent: "Mozilla/5.0 test" });
    expect(o.path).toBe("/api/v1/p/<token>?email=REDACTED&token=REDACTED");
    expect(o.requestId).toBeTruthy();
    const stored = JSON.stringify({ group, o });
    expect(stored).not.toContain(LINK);
    expect(stored).not.toContain("jane.doe");
    expect(stored).not.toContain("secret-cookie");
  });

  it("files a staff request's failure under the tenant and the user id, not the address", async () => {
    vi.spyOn(world.ctx.services.stats, "dashboard").mockRejectedValueOnce(
      new TypeError(`${tag} dashboard 42`),
    );
    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/stats",
      headers: as(world.adminToken),
    });
    expect(res.statusCode).toBe(500);
    await world.ctx.errors.flush();
    const [group] = await groups({ message: { contains: `${tag} dashboard` } });
    const admin = await world.db.user.findFirstOrThrow({ where: { email: world.adminEmail } });
    expect(group).toMatchObject({ companyId: world.companyId, name: "TypeError", route: "/api/v1/stats" });
    expect(group!.occurrences[0]).toMatchObject({ userId: admin.id, companyId: world.companyId });
    expect(JSON.stringify(group)).not.toContain(world.adminEmail);
  });

  it("does not record what is the API working: validation, auth, not found, rate limits", async () => {
    const before = await world.db.errorOccurrence.count();
    await world.app.inject({ method: "GET", url: "/api/v1/stats" });
    await world.app.inject({ method: "GET", url: "/api/v1/campaigns/nope", headers: as(world.adminToken) });
    await world.app.inject({ method: "GET", url: "/api/v1/no-such-route" });
    await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: as(world.adminToken),
      payload: {},
    });
    await world.ctx.errors.flush();
    expect(await world.db.errorOccurrence.count()).toBe(before);
  });

  it("takes a browser report on the public route, with the credential's tenant, and bounds it", async () => {
    const report = {
      kind: "error",
      name: "TypeError",
      message: `${tag} browser cannot read properties of undefined`,
      stack: `TypeError: x\n    at click (https://app.test/_next/static/chunks/app-1a2b3c4d5e.js:1:2)`,
      path: `/p/${LINK}?code=123456`,
    };
    const ok = await world.app.inject({
      method: "POST",
      url: "/api/v1/public/errors",
      headers: { ...as(world.adminToken), "user-agent": "Browser/1" },
      payload: report,
      remoteAddress: "198.51.100.7",
    });
    expect(ok.statusCode).toBe(204);
    await world.ctx.errors.flush();
    const [group] = await groups({ message: { contains: `${tag} browser` } });
    expect(group).toMatchObject({ source: "browser", companyId: world.companyId, route: "/p/<token>" });
    expect(group!.occurrences[0]).toMatchObject({ path: "/p/<token>?code=REDACTED", userAgent: "Browser/1" });

    // A closed schema and an 8 KB ceiling.
    const bad = await world.app.inject({
      method: "POST",
      url: "/api/v1/public/errors",
      payload: { kind: "nope", message: "x", path: "/" },
      remoteAddress: "198.51.100.8",
    });
    expect(bad.statusCode).toBe(400);
    const huge = await world.app.inject({
      method: "POST",
      url: "/api/v1/public/errors",
      payload: { kind: "error", message: "x", path: "/", stack: "s".repeat(9000) },
      remoteAddress: "198.51.100.8",
    });
    expect(huge.statusCode).toBe(413);
  });

  it("limits browser reports per address, whoever is signed in", async () => {
    const send = (address: string, token?: string) =>
      world.app.inject({
        method: "POST",
        url: "/api/v1/public/errors",
        headers: token ? as(token) : {},
        payload: { kind: "error", message: `${tag} flood`, path: "/" },
        remoteAddress: address,
      });
    const codes: number[] = [];
    for (let i = 0; i < BROWSER_REPORTS_PER_MINUTE + 2; i++)
      codes.push((await send("203.0.113.9", i % 2 ? world.adminToken : undefined)).statusCode);
    expect(codes.filter((c) => c === 204)).toHaveLength(BROWSER_REPORTS_PER_MINUTE);
    expect(codes.at(-1)).toBe(429);
    expect((await send("203.0.113.10")).statusCode).toBe(204);
    // Eleven reports of one fault: a group for the visitor's (the platform's) and one for the
    // signed-in tenant's, each with one stored occurrence and the rest counted.
    await world.ctx.errors.flush();
    const flood = await groups({ message: `${tag} flood` });
    expect(flood.map((g) => g.companyId).sort()).toEqual([null, world.companyId].sort());
    expect(flood.reduce((n, g) => n + g.count, 0)).toBe(BROWSER_REPORTS_PER_MINUTE + 1);
    for (const g of flood) expect(g.occurrences).toHaveLength(1);
  });

  it("takes the web server's reports only with the internal secret", async () => {
    const body = {
      message: `${tag} render failed`,
      path: "/admin/campaigns/c1",
      routePath: "/admin/campaigns/[id]",
    };
    const refused = await world.app.inject({ method: "POST", url: "/api/v1/internal/errors", payload: body });
    expect(refused.statusCode).toBe(401);
    const ok = await world.app.inject({
      method: "POST",
      url: "/api/v1/internal/errors",
      headers: { "x-internal-auth": TEST_INTERNAL_SECRET },
      payload: body,
    });
    expect(ok.statusCode).toBe(204);
    await world.ctx.errors.flush();
    const [group] = await groups({ message: { contains: `${tag} render` } });
    expect(group).toMatchObject({ source: "web", route: "/admin/campaigns/[id]", companyId: null });
  });

  it("keeps the log to the platform operator", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/operator/errors"],
      ["GET", "/api/v1/operator/errors/summary"],
      ["GET", "/api/v1/operator/errors/x"],
      ["POST", "/api/v1/operator/errors/x/resolve"],
      ["DELETE", "/api/v1/operator/errors/x"],
    ] as const) {
      expect((await world.app.inject({ method, url })).statusCode, `${method} ${url} anonymous`).toBe(401);
      const admin = await world.app.inject({ method, url, headers: as(world.adminToken) });
      expect(admin.statusCode, `${method} ${url} tenant admin`).toBe(403);
    }
  });

  it("lists, filters and summarises groups for the operator, with the tenant's name", async () => {
    const list = await world.app.inject({
      method: "GET",
      url: `/api/v1/operator/errors?q=${encodeURIComponent(`${tag} dashboard`)}&source=api&tenant=${world.companyId}`,
      headers: as(world.operatorToken),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      groups: { id: string; tenantName: string; count24h: number; status: string }[];
      total: number;
    }>();
    expect(body.total).toBe(1);
    expect(body.groups[0]).toMatchObject({ status: "open", count24h: 1 });
    expect(body.groups[0]?.tenantName).toMatch(/^Test /);

    const platform = await world.app.inject({
      method: "GET",
      url: `/api/v1/operator/errors?tenant=platform&q=${encodeURIComponent(tag)}`,
      headers: as(world.operatorToken),
    });
    expect(
      platform
        .json<{ groups: { source: string }[] }>()
        .groups.map((g) => g.source)
        .sort(),
    ).toEqual(["api", "browser", "web"]);

    const summary = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/errors/summary",
      headers: as(world.operatorToken),
    });
    const s = summary.json<{ open24h: number; last24h: number; last7d: number }>();
    expect(s.open24h).toBeGreaterThanOrEqual(5);
    expect(s.last7d).toBeGreaterThanOrEqual(s.last24h);
    expect(s.last24h).toBeGreaterThanOrEqual(15);

    const bad = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/errors?period=forever",
      headers: as(world.operatorToken),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("shows a group's occurrences, resolves it (audited), and a new occurrence reopens it", async () => {
    const [group] = await groups({ message: { contains: `${tag} dashboard` } });
    const id = group!.id;
    const detail = await world.app.inject({
      method: "GET",
      url: `/api/v1/operator/errors/${id}`,
      headers: as(world.operatorToken),
    });
    expect(detail.statusCode).toBe(200);
    const d = detail.json<{ group: { id: string }; occurrences: { stack: string }[]; elsewhere: number }>();
    expect(d.group.id).toBe(id);
    expect(d.occurrences[0]?.stack).toContain("TypeError");

    const resolved = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/errors/${id}/resolve`,
      headers: as(world.operatorToken),
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<{ group: { status: string } }>().group.status).toBe("resolved");
    const op = await world.db.user.findFirstOrThrow({ where: { email: world.operatorEmail } });
    const row = await world.db.auditLog.findFirst({ where: { action: "error_group.resolve", targetId: id } });
    expect(row).toMatchObject({ actorId: op.id, companyId: op.companyId, targetType: "error_group" });

    vi.spyOn(world.ctx.services.stats, "dashboard").mockRejectedValueOnce(
      new TypeError(`${tag} dashboard 7`),
    );
    await world.app.inject({ method: "GET", url: "/api/v1/stats", headers: as(world.adminToken) });
    await world.ctx.errors.flush();
    const reopened = await world.db.errorGroup.findUniqueOrThrow({ where: { id } });
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.count).toBe(2);
  });

  it("deletes a group with its occurrences, audited, and answers 404 after", async () => {
    const [group] = await groups({ message: { contains: `${tag} render` } });
    const id = group!.id;
    const res = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/operator/errors/${id}`,
      headers: as(world.operatorToken),
    });
    expect(res.statusCode).toBe(200);
    expect(await world.db.errorOccurrence.count({ where: { groupId: id } })).toBe(0);
    expect(await world.db.auditLog.count({ where: { action: "error_group.delete", targetId: id } })).toBe(1);
    const gone = await world.app.inject({
      method: "GET",
      url: `/api/v1/operator/errors/${id}`,
      headers: as(world.operatorToken),
    });
    expect(gone.statusCode).toBe(404);
  });
});

import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, TEST_AUTH_SECRET, type TestWorld } from "./helpers.js";

/*
 * D-344 and D-345: the account page's two writes (own display name, sign out everywhere) and the
 * audit log as a CSV. Each is the admin shell's foundation for a page the owner asked for.
 */
describeDb("own profile, session revocation and audit export", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const admin = () => ({ authorization: `Bearer ${world.adminToken}` });

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  it("changes only the caller's own display name and writes an audit row", async () => {
    const res = await world.app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: admin(),
      payload: { name: "  Ada Lovelace  " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { name: string; role: string } }>().user.name).toBe("Ada Lovelace");

    const me = await world.app.inject({ method: "GET", url: "/api/v1/me", headers: admin() });
    expect(me.json<{ user: { name: string } }>().user.name).toBe("Ada Lovelace");

    const row = await world.db.auditLog.findFirst({
      where: { companyId: world.companyId, action: "user.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(row?.diff).toMatchObject({ name: "Ada Lovelace", self: true });
  });

  it("clears the name with null and refuses a name past 120 characters", async () => {
    const cleared = await world.app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: admin(),
      payload: { name: null },
    });
    expect(cleared.json<{ user: { name: string | null } }>().user.name).toBeNull();
    const long = await world.app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: admin(),
      payload: { name: "x".repeat(121) },
    });
    expect(long.statusCode).toBe(400);
  });

  it("does not let a request set role or email through the profile route", async () => {
    const res = await world.app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: admin(),
      payload: { name: "Ada", role: "platform_operator", email: "x@evil.test" },
    });
    // Unknown keys are dropped by the schema; the role is whatever it was.
    expect(res.statusCode).toBe(200);
    const user = await world.db.user.findFirstOrThrow({ where: { email: world.adminEmail } });
    expect(user.role).toBe("admin");
    expect(user.email).toBe(world.adminEmail);
  });

  it("is refused without a session", async () => {
    const res = await world.app.inject({ method: "PATCH", url: "/api/v1/me", payload: { name: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("signing out everywhere refuses tokens signed in before it, and honours a later sign-in", async () => {
    const mint = (authAt: number, iat?: number) =>
      encode({
        token: { email: world.adminEmail, authAt, ...(iat ? { iat } : {}) },
        secret: TEST_AUTH_SECRET,
        salt: "authjs.session-token",
      });
    const before = Math.floor(Date.now() / 1000) - 3600;
    const old = await mint(before);
    expect(
      (
        await world.app.inject({
          method: "GET",
          url: "/api/v1/me",
          headers: { authorization: `Bearer ${old}` },
        })
      ).statusCode,
    ).toBe(200);

    // Without the confirmation nothing happens.
    const empty = await world.app.inject({
      method: "POST",
      url: "/api/v1/me/sessions/revoke",
      headers: { authorization: `Bearer ${old}` },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const revoke = await world.app.inject({
      method: "POST",
      url: "/api/v1/me/sessions/revoke",
      headers: { authorization: `Bearer ${old}` },
      payload: { confirm: true },
    });
    expect(revoke.statusCode).toBe(200);

    // The old session is gone, even though its own token was re-issued a moment ago (`iat` is now):
    // the sign-in time is what counts.
    const refreshed = await mint(before, Math.floor(Date.now() / 1000));
    expect(
      (
        await world.app.inject({
          method: "GET",
          url: "/api/v1/me",
          headers: { authorization: `Bearer ${refreshed}` },
        })
      ).statusCode,
    ).toBe(401);

    // A sign-in after the watermark works.
    const later = await mint(Math.floor(Date.now() / 1000) + 5);
    expect(
      (
        await world.app.inject({
          method: "GET",
          url: "/api/v1/me",
          headers: { authorization: `Bearer ${later}` },
        })
      ).statusCode,
    ).toBe(200);

    const row = await world.db.auditLog.findFirst({
      where: { companyId: world.companyId, action: "user.sessions_revoke" },
    });
    expect(row).not.toBeNull();
    // Leave the shared admin user usable for the rest of the file.
    await world.db.user.updateMany({ where: { email: world.adminEmail }, data: { tokensValidAfter: null } });
  });

  it("exports the audit log as CSV with the list's filters, and records the export", async () => {
    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/audit.csv?q=user.update",
      headers: admin(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const lines = res.body
      .replace(/^\ufeff/, "")
      .trimEnd()
      .split("\r\n");
    expect(lines[0]).toBe("created_at,actor,action,target_type,target_id,details");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((l) => l.includes("user.update"))).toBe(true);

    const logged = await world.db.auditLog.findFirst({
      where: { companyId: world.companyId, action: "audit.export" },
    });
    expect(logged?.diff).toMatchObject({ truncated: false });
  });

  it("refuses the export to a member", async () => {
    const member = await encode({
      token: { email: "member-audit-export@test.local" },
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });
    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/audit.csv",
      headers: { authorization: `Bearer ${member}` },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
});

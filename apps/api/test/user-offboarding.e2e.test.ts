import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, TEST_AUTH_SECRET, type TestWorld } from "./helpers.js";

/**
 * Staff offboarding (P10, D-161): a user can be disabled and deleted, a disabled user's tokens
 * stop working on the next request, the last administrator and yourself are protected, and what a
 * deleted user owned is reassigned, not orphaned.
 */
describeDb("user disable and delete", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const token = (email: string) =>
    encode({ token: { email }, secret: TEST_AUTH_SECRET, salt: "authjs.session-token" });
  const as = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function newUser(role: "admin" | "member"): Promise<{ id: string; email: string; token: string }> {
    const email = `u-${Math.random().toString(36).slice(2)}@test.io`;
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: as(world.adminToken),
      payload: { email, role },
    });
    expect(res.statusCode).toBe(201);
    return { id: res.json<{ user: { id: string } }>().user.id, email, token: await token(email) };
  }

  const me = (t: string) => world.app.inject({ method: "GET", url: "/api/v1/me", headers: as(t) });
  const patch = (actor: string, id: string, payload: unknown, extra: Record<string, string> = {}) =>
    world.app.inject({
      method: "PATCH",
      url: `/api/v1/users/${id}`,
      headers: { ...as(actor), ...extra },
      payload: payload as object,
    });

  it("ends a disabled user's open session on the very next request", async () => {
    const victim = await newUser("member");
    expect((await me(victim.token)).statusCode).toBe(200);

    const res = await patch(world.adminToken, victim.id, { disabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.disabledAt).not.toBeNull();

    // The same JWT, 30 days from expiry, is now nobody.
    expect((await me(victim.token)).statusCode).toBe(401);
  });

  it("keeps old tokens dead after re-enabling, and lets a fresh sign-in through", async () => {
    const person = await newUser("member");
    await patch(world.adminToken, person.id, { disabled: true });
    await sleep(1100);
    const res = await patch(world.adminToken, person.id, { disabled: false });
    expect(res.json().user.disabledAt).toBeNull();

    // The token from before the revocation stays revoked ...
    expect((await me(person.token)).statusCode).toBe(401);
    // ... and a token issued after it works.
    await sleep(1100);
    expect((await me(await token(person.email))).statusCode).toBe(200);
  });

  it("refuses to disable, demote or delete yourself", async () => {
    const other = await newUser("admin");
    expect((await patch(other.token, other.id, { disabled: true })).statusCode).toBe(409);
    expect((await patch(other.token, other.id, { role: "member" })).statusCode).toBe(409);
    const del = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/users/${other.id}`,
      headers: as(other.token),
    });
    expect(del.statusCode).toBe(409);
    expect((await me(other.token)).statusCode).toBe(200);
  });

  it("never removes the last enabled administrator, by disable, demote or delete", async () => {
    // A tenant of its own, with one admin, so the count is exact. The operator acts from outside.
    const company = await world.db.company.create({ data: { name: "Solo", status: "active" } });
    const solo = await world.db.user.create({
      data: {
        companyId: company.id,
        email: `solo-${Math.random().toString(36).slice(2)}@test.io`,
        role: "admin",
      },
    });
    const operator = { ...as(world.operatorToken), "x-company-id": company.id };

    expect(
      (
        await world.app.inject({
          method: "PATCH",
          url: `/api/v1/users/${solo.id}`,
          headers: operator,
          payload: { disabled: true },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await world.app.inject({
          method: "PATCH",
          url: `/api/v1/users/${solo.id}`,
          headers: operator,
          payload: { role: "member" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await world.app.inject({ method: "DELETE", url: `/api/v1/users/${solo.id}`, headers: operator }))
        .statusCode,
    ).toBe(409);
    expect(await world.db.user.findUnique({ where: { id: solo.id } })).toMatchObject({
      role: "admin",
      disabledAt: null,
    });

    // With a second administrator it is allowed, and not before.
    await world.db.user.create({
      data: {
        companyId: company.id,
        email: `second-${Math.random().toString(36).slice(2)}@test.io`,
        role: "admin",
      },
    });
    expect(
      (
        await world.app.inject({
          method: "PATCH",
          url: `/api/v1/users/${solo.id}`,
          headers: operator,
          payload: { disabled: true },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("does not count a disabled administrator as one that is left", async () => {
    const company = await world.db.company.create({ data: { name: "Pair", status: "active" } });
    const suffix = Math.random().toString(36).slice(2);
    const x = await world.db.user.create({
      data: { companyId: company.id, email: `x-${suffix}@test.io`, role: "admin" },
    });
    const y = await world.db.user.create({
      data: { companyId: company.id, email: `y-${suffix}@test.io`, role: "admin" },
    });
    const operator = { ...as(world.operatorToken), "x-company-id": company.id };
    const asX = as(await token(x.email));

    // Two enabled admins: one may go.
    const first = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/users/${y.id}`,
      headers: asX,
      payload: { disabled: true },
    });
    expect(first.statusCode).toBe(200);
    // y is disabled, so x is the last one left, and nobody may remove x.
    const second = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/users/${x.id}`,
      headers: operator,
      payload: { disabled: true },
    });
    expect(second.statusCode).toBe(409);
    // Re-enabling y makes x removable again.
    await world.app.inject({
      method: "PATCH",
      url: `/api/v1/users/${y.id}`,
      headers: operator,
      payload: { disabled: false },
    });
    const third = await world.app.inject({
      method: "PATCH",
      url: `/api/v1/users/${x.id}`,
      headers: operator,
      payload: { disabled: true },
    });
    expect(third.statusCode).toBe(200);
  });

  it("reassigns a deleted user's campaigns to the admin who deleted them, and audits it", async () => {
    const leaver = await newUser("admin");
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: as(leaver.token),
      payload: { templateId: world.templateId, name: "Left behind", verification: "open" },
    });
    expect(created.statusCode).toBe(201);
    const campaignId = created.json<{ campaign: { id: string } }>().campaign.id;
    const admin = await world.db.user.findFirstOrThrow({ where: { email: world.adminEmail } });

    const del = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/users/${leaver.id}`,
      headers: as(world.adminToken),
    });
    expect(del.statusCode).toBe(200);

    expect(await world.db.user.findUnique({ where: { id: leaver.id } })).toBeNull();
    expect(await world.db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({
      createdById: admin.id,
    });
    expect((await me(leaver.token)).statusCode).toBe(401);

    const row = await world.db.auditLog.findFirstOrThrow({
      where: { companyId: world.companyId, action: "user.delete", targetId: leaver.id },
    });
    expect(row.actorId).toBe(admin.id);
    expect(JSON.stringify(row.diff)).not.toContain(leaver.email);
    expect(row.diff).toMatchObject({ reassigned: { campaigns: 1 } });
  });

  it("gives a campaign to a remaining admin when the operator deletes its owner", async () => {
    const leaver = await newUser("admin");
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: as(leaver.token),
      payload: { templateId: world.templateId, name: "Operator cleanup", verification: "open" },
    });
    const campaignId = created.json<{ campaign: { id: string } }>().campaign.id;
    const del = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/users/${leaver.id}`,
      headers: { ...as(world.operatorToken), "x-company-id": world.companyId },
    });
    expect(del.statusCode).toBe(200);
    const owner = await world.db.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      include: { createdBy: true },
    });
    // Never the operator, who is not a member of this tenant.
    expect(owner.createdBy.companyId).toBe(world.companyId);
    expect(owner.createdBy.role).toBe("admin");
  });

  it("refuses a member and answers 404 across tenants", async () => {
    const member = await newUser("member");
    const target = await newUser("member");
    expect((await patch(member.token, target.id, { disabled: true })).statusCode).toBe(403);
    const del = await world.app.inject({
      method: "DELETE",
      url: `/api/v1/users/${target.id}`,
      headers: as(member.token),
    });
    expect(del.statusCode).toBe(403);

    const other = await world.db.company.create({ data: { name: "Elsewhere", status: "active" } });
    const stranger = await world.db.user.create({
      data: {
        companyId: other.id,
        email: `s-${Math.random().toString(36).slice(2)}@test.io`,
        role: "member",
      },
    });
    expect((await patch(world.adminToken, stranger.id, { disabled: true })).statusCode).toBe(404);
    expect(
      (
        await world.app.inject({
          method: "DELETE",
          url: `/api/v1/users/${stranger.id}`,
          headers: as(world.adminToken),
        })
      ).statusCode,
    ).toBe(404);
  });
});

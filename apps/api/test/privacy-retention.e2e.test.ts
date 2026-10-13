import type { Server } from "node:http";
import { RETENTION_SWEEP_ACTION } from "@aidp/core";
import { describeDb } from "@aidp/testing";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = describeDb;

const monthsAgo = (n: number): Date => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};

interface RetentionBody {
  retentionMonths: number;
  oldestSessionAt: string | null;
  expiredSessions: number;
  lastSweepAt: string | null;
}

suite("GET /privacy/retention (spec 11)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let memberToken: string;

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url);
    const memberEmail = `member-${Date.now().toString(36)}@test.io`;
    await world.db.user.create({
      data: { companyId: world.companyId, email: memberEmail, role: "member" },
    });
    memberToken = await encode({
      token: { email: memberEmail },
      secret: world.ctx.config.AUTH_SECRET,
      salt: "authjs.session-token",
    });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const get = (token: string) =>
    world.app.inject({
      method: "GET",
      url: "/api/v1/privacy/retention",
      headers: { authorization: `Bearer ${token}` },
    });

  it("reports the window in force, what is past it, and the last sweep", async () => {
    const { db, companyId, templateId } = world;
    const old = await db.session.create({
      data: {
        companyId,
        templateId,
        status: "completed",
        createdAt: monthsAgo(40),
        endedAt: monthsAgo(39),
      },
    });
    // Inside the platform's 24 months, outside a 6-month tenant window.
    await db.session.create({
      data: { companyId, templateId, status: "completed", createdAt: monthsAgo(9), endedAt: monthsAgo(8) },
    });
    await db.session.create({
      data: { companyId, templateId, status: "completed", createdAt: monthsAgo(1), endedAt: monthsAgo(1) },
    });

    const first = (await get(world.adminToken)).json<RetentionBody>();
    expect(first.retentionMonths).toBe(24);
    expect(first.expiredSessions).toBe(1);
    expect(Date.parse(first.oldestSessionAt ?? "")).toBeLessThan(monthsAgo(39).getTime());
    expect(first.lastSweepAt).toBeNull();

    // A stricter tenant window is what the route reports, and moves the count.
    await world.ctx.settings.set(
      { scope: "tenant", scopeId: companyId },
      { "privacy.retentionMonths": 6 },
      null,
    );
    const stricter = (await get(world.adminToken)).json<RetentionBody>();
    expect(stricter.retentionMonths).toBe(6);
    expect(stricter.expiredSessions).toBe(2);

    // Once the sweep has anonymized them, nothing is past the window and the sweep date shows.
    await db.session.updateMany({
      where: { companyId },
      data: { status: "deleted", state: {}, summary: "" },
    });
    await db.auditLog.create({
      data: {
        companyId,
        actorId: null,
        action: RETENTION_SWEEP_ACTION,
        targetType: "company",
        targetId: companyId,
        diff: { deleted: 2, retentionMonths: 6, olderThan: monthsAgo(6).toISOString() },
      },
    });
    const swept = (await get(world.adminToken)).json<RetentionBody>();
    expect(swept.expiredSessions).toBe(0);
    expect(swept.lastSweepAt).not.toBeNull();
    expect(swept.oldestSessionAt).toBeNull();
    expect(JSON.stringify(swept)).not.toContain(old.id);
  });

  it("is admin-only", async () => {
    expect((await get(memberToken)).statusCode).toBe(403);
    expect((await get(world.adminToken)).statusCode).toBe(200);
    const anonymous = await world.app.inject({ method: "GET", url: "/api/v1/privacy/retention" });
    expect(anonymous.statusCode).toBe(401);
  });
});

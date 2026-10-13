import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * The jobs page's server side (D-92): a dead letter is visible, retryable and discardable by the
 * platform operator, nobody else, and every verb leaves an audit row.
 */
suite("operator job administration", () => {
  let world: TestWorld;
  let model: { server: Server; url: string };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it("keeps the whole surface to the platform operator", async () => {
    for (const [method, url] of [
      ["GET", "/api/v1/operator/jobs"],
      ["GET", "/api/v1/operator/jobs/dead?queue=analysis.run"],
      ["POST", "/api/v1/operator/jobs/dead/analysis.run/x/retry"],
      ["POST", "/api/v1/operator/jobs/dead/analysis.run/x/discard"],
      ["POST", "/api/v1/operator/jobs/run/ops.health-sweep"],
    ] as const) {
      const anon = await world.app.inject({ method, url });
      expect(anon.statusCode, `${method} ${url} anonymous`).toBe(401);
      const admin = await world.app.inject({ method, url, headers: as(world.adminToken) });
      expect(admin.statusCode, `${method} ${url} tenant admin`).toBe(403);
    }
  });

  it("lists every queue with its expiry and retry policy", async () => {
    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/jobs",
      headers: as(world.operatorToken),
    });
    expect(res.statusCode).toBe(200);
    const { queues } = res.json<{
      queues: { name: string; expireInSeconds: number; runNow: boolean; deadLettered: number }[];
    }>();
    const analysis = queues.find((q) => q.name === "analysis.run");
    expect(analysis).toMatchObject({ expireInSeconds: 3600, runNow: false });
    expect(queues.find((q) => q.name === "ops.health-sweep")).toMatchObject({ runNow: true });
  });

  it("retries a dead-lettered job from the route: queued again, alert resolved, audited on its tenant", async () => {
    const dead = world.jobAdmin.addDead("analysis.run", {
      id: "11111111-1111-4111-8111-111111111111",
      sourceId: "22222222-2222-4222-8222-222222222222",
      raw: { analysisId: "an-1", companyId: world.companyId },
      error: "provider timed out",
    });

    const list = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/jobs/dead?queue=analysis.run",
      headers: as(world.operatorToken),
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json<{ jobs: { id: string; data: Record<string, string>; error: string }[] }>().jobs;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: dead.id,
      data: { analysisId: "an-1", companyId: world.companyId },
      error: "provider timed out",
    });

    const retry = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/jobs/dead/analysis.run/${dead.id}/retry`,
      headers: as(world.operatorToken),
    });
    expect(retry.statusCode).toBe(200);
    expect(world.jobAdmin.requeued).toEqual([
      { queue: "analysis.run", data: { analysisId: "an-1", companyId: world.companyId } },
    ]);
    // The alert the handler raised under the original job's id is cleared with it.
    expect(world.alerts.resolved).toContain(
      "job.dead_lettered:analysis.run:22222222-2222-4222-8222-222222222222",
    );
    const audit = await world.db.auditLog.findFirst({
      where: { companyId: world.companyId, action: "job.retry", targetId: dead.id },
    });
    expect(audit).not.toBeNull();

    const again = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/jobs/dead/analysis.run/${dead.id}/retry`,
      headers: as(world.operatorToken),
    });
    expect(again.statusCode).toBe(404);
  });

  it("answers 409 and leaves the dead letter in place when it cannot be queued again", async () => {
    const dead = world.jobAdmin.addDead("spec.generate", {
      id: "33333333-3333-4333-8333-333333333333",
      raw: { versionId: "v1", companyId: world.companyId },
    });
    world.jobAdmin.refuseRequeue = true;
    try {
      const res = await world.app.inject({
        method: "POST",
        url: `/api/v1/operator/jobs/dead/spec.generate/${dead.id}/retry`,
        headers: as(world.operatorToken),
      });
      expect(res.statusCode).toBe(409);
      expect(world.jobAdmin.dead.get("spec.generate")).toHaveLength(1);
    } finally {
      world.jobAdmin.refuseRequeue = false;
    }
  });

  it("discards a dead letter and audits it", async () => {
    const dead = world.jobAdmin.addDead("email.send", {
      id: "44444444-4444-4444-8444-444444444444",
      raw: { to: "someone@example.com", subject: "s", text: "t" },
    });
    // Nothing from an email payload but ids may be shown: the address is not an id.
    const list = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/jobs/dead?queue=email.send",
      headers: as(world.operatorToken),
    });
    expect(JSON.stringify(list.json())).not.toContain("someone@example.com");

    const res = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/jobs/dead/email.send/${dead.id}/discard`,
      headers: as(world.operatorToken),
    });
    expect(res.statusCode).toBe(200);
    expect(world.jobAdmin.discarded).toContain(dead.id);
    const audit = await world.db.auditLog.findFirst({ where: { action: "job.discard", targetId: dead.id } });
    expect(audit).not.toBeNull();
  });

  it("runs a parameterless recurring job now, and refuses one that needs a payload", async () => {
    const ok = await world.app.inject({
      method: "POST",
      url: "/api/v1/operator/jobs/run/ops.health-sweep",
      headers: as(world.operatorToken),
    });
    expect(ok.statusCode).toBe(200);
    expect(world.jobs.published.at(-1)).toMatchObject({ name: "ops.health-sweep", payload: {} });

    const refused = await world.app.inject({
      method: "POST",
      url: "/api/v1/operator/jobs/run/analysis.run",
      headers: as(world.operatorToken),
    });
    expect(refused.statusCode).toBe(400);
  });

  it("rejects an unknown queue name before touching the queue", async () => {
    const res = await world.app.inject({
      method: "GET",
      url: "/api/v1/operator/jobs/dead?queue=not.a.queue",
      headers: as(world.operatorToken),
    });
    expect(res.statusCode).toBe(400);
  });
});

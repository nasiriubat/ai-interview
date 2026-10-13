import { withSystemTenant, withTenant, withTenantScope } from "@aidp/db";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BossJobs, JOBS, PgBossJobAdmin, type JobFailure } from "../src/index.js";

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

/** Polls until `check` returns a value, so a test waits for pg-boss's worker loop and not a fixed sleep. */
async function until<T>(check: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out waiting for the queue");
    await new Promise((r) => setTimeout(r, 250));
  }
}

suite("job administration against a real pg-boss", () => {
  const db = new PrismaClient();
  const jobs = new BossJobs(url ?? "");
  const admin = new PgBossJobAdmin(jobs.boss, db);
  const companyId = `jobs_${Date.now().toString(36)}`;
  const failures: { id: string; failure: JobFailure }[] = [];

  beforeAll(async () => {
    await jobs.start();
    await jobs.consume(
      "session.summarize",
      async () => {
        throw new Error("model said no");
      },
      1,
      (id, _err, failure) => failures.push({ id, failure }),
    );
  });

  afterAll(async () => {
    await jobs.stop();
    await db.$executeRawUnsafe(
      `delete from pgboss.job where name in ('session.summarize', 'session.summarize.dead') and data->>'companyId' = '${companyId}'`,
    );
    await db.$disconnect();
  });

  it("applies each job's own expiry to its queue, including a queue that already existed", async () => {
    const queues = await jobs.boss.getQueues();
    for (const [name, def] of Object.entries(JOBS)) {
      const q = queues.find((x) => x.name === name);
      expect(q?.expireInSeconds, name).toBe(def.expireInSeconds);
    }
    // A second start() is what a deploy does; it must converge on the same values.
    await jobs.start();
    const again = (await jobs.boss.getQueues()).find((x) => x.name === "analysis.run");
    expect(again?.expireInSeconds).toBe(3600);
  });

  it("dead-letters a job that fails its last attempt, tells the consumer it was the last, and lists it", async () => {
    await jobs.boss.send(
      "session.summarize",
      { sessionId: "sess-1", companyId },
      { retryLimit: 0, expireInSeconds: 60 },
    );
    const dead = await until(async () => {
      const list = (await admin.deadLetters("session.summarize", 50)).filter(
        (j) => j.companyId === companyId,
      );
      return list.length > 0 ? list : undefined;
    });
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      queue: "session.summarize",
      companyId,
      data: { sessionId: "sess-1", companyId },
    });
    expect(dead[0]?.error).toContain("model said no");
    expect(failures.at(-1)?.failure).toMatchObject({ attempt: 1, retryLimit: 0, final: true });
    expect(failures.at(-1)?.failure.data).toMatchObject({ companyId });

    const summary = (await admin.list()).find((q) => q.name === "session.summarize");
    expect(summary?.deadLettered).toBeGreaterThanOrEqual(1);
    expect(summary?.lastFailure).not.toBeNull();
  });

  it("retries a dead letter: queued again with its payload, gone from the dead list", async () => {
    const [job] = (await admin.deadLetters("session.summarize", 50)).filter((j) => j.companyId === companyId);
    expect(job).toBeDefined();
    const result = await admin.retry("session.summarize", job?.id ?? "");
    expect(result?.queuedAs).toEqual(expect.any(String));
    const still = (await admin.deadLetters("session.summarize", 50)).filter((j) => j.id === job?.id);
    expect(still).toHaveLength(0);
    // It is a new job in the live queue with the original payload and a full attempt budget.
    const [queued] = await jobs.boss.findJobs<{ sessionId: string; companyId: string }>("session.summarize", {
      id: result?.queuedAs ?? "",
    });
    expect(queued?.data).toEqual({ sessionId: "sess-1", companyId });
    expect(queued?.retryLimit).toBe(JOBS["session.summarize"].retryLimit);
    expect(queued?.expireInSeconds).toBe(JOBS["session.summarize"].expireInSeconds);
  });

  it("discards a dead letter and answers null for one that is not there", async () => {
    await jobs.boss.send(
      "session.summarize",
      { sessionId: "sess-2", companyId },
      { retryLimit: 0, expireInSeconds: 60 },
    );
    const dead = await until(async () => {
      const list = (await admin.deadLetters("session.summarize", 50)).filter(
        (j) => j.companyId === companyId && j.data.sessionId === "sess-2",
      );
      return list[0];
    });
    expect(await admin.discard("session.summarize", dead.id)).not.toBeNull();
    expect(await admin.discard("session.summarize", dead.id)).toBeNull();
    expect(await admin.retry("session.summarize", "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await admin.retry("session.summarize", "not-a-uuid")).toBeNull();
  });

  it("answers the same through the unprivileged runtime role and the tenant scope, which is how the API and worker run it", async () => {
    await db.$executeRawUnsafe(`ALTER ROLE app_api WITH LOGIN PASSWORD 'test-app-role'`);
    const u = new URL(url ?? "");
    u.username = "app_api";
    u.password = "test-app-role";
    const api = new PrismaClient({ datasources: { db: { url: u.toString() } } });
    try {
      const scoped = withTenantScope(api);
      const asApi = new PgBossJobAdmin(jobs.boss, scoped);
      // The route handler runs with the operator's tenant in context; the sweep runs as system.
      const listed = await withTenant(companyId, async () => asApi.list());
      expect(listed.map((q) => q.name).sort()).toEqual(Object.keys(JOBS).sort());
      const stuck = await withSystemTenant(async () => asApi.stuck());
      expect(Array.isArray(stuck)).toBe(true);
      const dead = await withSystemTenant(async () => asApi.deadLetters("session.summarize", 5));
      expect(Array.isArray(dead)).toBe(true);
    } finally {
      await api.$disconnect();
    }
  });

  it("reports a job that has been active past its expiry plus the grace period", async () => {
    const id = await jobs.boss.send(
      "session.summarize",
      { sessionId: "stuck", companyId },
      { startAfter: 3600 },
    );
    expect(id).not.toBeNull();
    await db.$executeRawUnsafe(
      `update pgboss.job set state = 'active', started_on = now() - interval '2 hours' where name = 'session.summarize' and id = '${id}'`,
    );
    const stuck = await admin.stuck();
    expect(stuck.find((s) => s.name === "session.summarize")?.count).toBeGreaterThanOrEqual(1);
    await db.$executeRawUnsafe(`delete from pgboss.job where name = 'session.summarize' and id = '${id}'`);
    const after = await admin.stuck();
    expect(after.find((s) => s.name === "session.summarize")?.count ?? 0).toBe(0);
  });
});

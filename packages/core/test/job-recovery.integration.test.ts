import { describeDb } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BossJobs, JobRecovery } from "../src/index.js";

/**
 * A killed worker leaves its job `active` until the queue's own expiry (an hour for `analysis.run`).
 * These run against a real pg-boss: the job is fetched (made active) by one "worker", which then
 * disappears, and another worker's recovery decides what to do (D-281).
 */
describeDb("job recovery after a worker is killed", () => {
  const url = process.env.DATABASE_URL ?? "";
  const db = new PrismaClient();
  const jobs = new BossJobs(url, { workerId: "w-survivor" });
  const tag = Date.now().toString(36);

  const stateOf = async (id: string): Promise<string | undefined> => {
    const rows = await db.$queryRawUnsafe<{ state: string }[]>(
      `select state::text as state from pgboss.job where id = $1::uuid`,
      id,
    );
    return rows[0]?.state;
  };

  /** Sends a job and makes it active the way a worker's fetch does. */
  async function activeJob(): Promise<string> {
    const id = await jobs.boss.send(
      "session.summarize",
      { sessionId: `s-${tag}`, companyId: `c-${tag}` },
      { retryLimit: 2, expireInSeconds: 3600 },
    );
    if (!id) throw new Error("send returned no id");
    // Nothing consumes this queue in this suite, so a direct fetch is the only fetcher.
    const fetched = await jobs.boss.fetch("session.summarize", { batchSize: 10 });
    expect(fetched.map((j) => j.id)).toContain(id);
    // Anything else that was waiting is put back for the next test.
    for (const other of fetched.filter((j) => j.id !== id)) {
      await db.$executeRawUnsafe(`update pgboss.job set state = 'created' where id = $1::uuid`, other.id);
    }
    return id;
  }

  beforeAll(async () => {
    await jobs.start();
    expect(await jobs.recovery.start()).toBe(true);
  });
  afterAll(async () => {
    await db.$executeRawUnsafe(`delete from pgboss.job where data->>'companyId' = 'c-${tag}'`);
    await db.$executeRawUnsafe(`delete from pgboss.aidp_job_claim where worker_id like 'w-%-${tag}'`);
    await db.$executeRawUnsafe(`delete from pgboss.aidp_worker_lease where worker_id like 'w-%-${tag}'`);
    await jobs.recovery.stop();
    await jobs.stop();
    await db.$disconnect();
  });

  it("fails and requeues an active job whose owner has no live lease", async () => {
    const id = await activeJob();
    const dead = new JobRecovery(jobs.boss, `w-dead-${tag}`);
    await dead.start();
    await dead.claim("session.summarize", id);
    // The worker was killed: its lease stops being refreshed.
    await db.$executeRawUnsafe(
      `update pgboss.aidp_worker_lease set beat_at = now() - interval '10 minutes' where worker_id = $1`,
      `w-dead-${tag}`,
    );
    expect(await stateOf(id)).toBe("active");

    const reclaimed = await jobs.recovery.reclaim();

    expect(reclaimed.map((r) => r.jobId)).toContain(id);
    // Failed with attempts left: waiting for its retry, not active, and not dead-lettered.
    expect(await stateOf(id)).toBe("retry");
  });

  it("leaves an active job alone while its owner's lease is live", async () => {
    const id = await activeJob();
    const alive = new JobRecovery(jobs.boss, `w-alive-${tag}`);
    await alive.start();
    await alive.claim("session.summarize", id);

    const reclaimed = await jobs.recovery.reclaim();

    expect(reclaimed.map((r) => r.jobId)).not.toContain(id);
    expect(await stateOf(id)).toBe("active");
  });

  it("leaves a job with no claim to the queue's own expiry", async () => {
    const id = await activeJob();
    const reclaimed = await jobs.recovery.reclaim();
    expect(reclaimed.map((r) => r.jobId)).not.toContain(id);
    expect(await stateOf(id)).toBe("active");
  });

  it("never fails one job twice when two workers reclaim at once", async () => {
    const id = await activeJob();
    const dead = new JobRecovery(jobs.boss, `w-gone-${tag}`);
    await dead.start();
    await dead.claim("session.summarize", id);
    await db.$executeRawUnsafe(`delete from pgboss.aidp_worker_lease where worker_id = $1`, `w-gone-${tag}`);

    const other = new JobRecovery(jobs.boss, `w-other-${tag}`);
    await other.start();
    const [a, b] = await Promise.all([jobs.recovery.reclaim(), other.reclaim()]);

    expect([...a, ...b].filter((r) => r.jobId === id)).toHaveLength(1);
    expect(await stateOf(id)).toBe("retry");
  });

  it("does not reclaim its own jobs", async () => {
    const id = await activeJob();
    await jobs.recovery.claim("session.summarize", id);
    await db.$executeRawUnsafe(
      `update pgboss.aidp_worker_lease set beat_at = now() - interval '10 minutes' where worker_id = 'w-survivor'`,
    );
    const reclaimed = await jobs.recovery.reclaim();
    expect(reclaimed.map((r) => r.jobId)).not.toContain(id);
    await jobs.recovery.beat();
  });
});

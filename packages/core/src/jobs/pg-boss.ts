import { PgBoss, type Job } from "pg-boss";
import { JOBS, type JobName, type JobPayload, type JobPublisher } from "./definitions.js";

/** pg-boss publisher and consumer helpers. One queue per job name, created on start. */
export class BossJobs implements JobPublisher {
  readonly boss: PgBoss;

  constructor(connectionString: string) {
    this.boss = new PgBoss({ connectionString, schema: "pgboss" });
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const [name, def] of Object.entries(JOBS)) {
      await this.boss.createQueue(`${name}.dead`);
      await this.boss.createQueue(name, {
        retryLimit: def.retryLimit,
        retryBackoff: true,
        retryDelay: 5,
        deadLetter: `${name}.dead`,
      });
    }
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  async publish<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options?: { singletonKey?: string },
  ): Promise<void> {
    JOBS[name].schema.parse(payload);
    await this.boss.send(name, payload, options?.singletonKey ? { singletonKey: options.singletonKey } : {});
  }

  /** Registers a typed handler; payloads are validated before the handler runs. */
  async consume<N extends JobName>(
    name: N,
    handler: (payload: JobPayload<N>, jobId: string) => Promise<void>,
    concurrency = 2,
  ): Promise<void> {
    await this.boss.work<unknown>(name, { batchSize: concurrency }, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) {
        const payload = JOBS[name].schema.parse(job.data) as JobPayload<N>;
        await handler(payload, job.id);
      }
    });
  }

  async queueStats(): Promise<{ name: string; queued: number; active: number; deadLettered: number }[]> {
    const out: { name: string; queued: number; active: number; deadLettered: number }[] = [];
    for (const name of Object.keys(JOBS)) {
      const q = (await this.boss.getQueueStats(name)).at(-1);
      const d = (await this.boss.getQueueStats(`${name}.dead`)).at(-1);
      out.push({
        name,
        queued: q?.queuedCount ?? 0,
        active: q?.activeCount ?? 0,
        deadLettered: (d?.queuedCount ?? 0) + (d?.activeCount ?? 0),
      });
    }
    return out;
  }
}

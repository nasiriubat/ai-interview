import { PgBoss, type Job } from "pg-boss";
import {
  JOBS,
  type JobName,
  type JobPayload,
  type JobPublisher,
  type ScheduleOptions,
} from "./definitions.js";

/** pg-boss publisher and consumer helpers. One queue per job name, created on start. */
export class BossJobs implements JobPublisher {
  readonly boss: PgBoss;

  constructor(connectionString: string, options: { onError?: (error: unknown) => void } = {}) {
    this.boss = new PgBoss({ connectionString, schema: "pgboss" });
    // pg-boss reports fetch and maintenance failures (a dropped connection, a timeout) as
    // `error` events; without a listener Node treats them as fatal and the process dies.
    this.boss.on(
      "error",
      options.onError ??
        ((err) => {
          console.error("pg-boss error", err);
        }),
    );
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

  /**
   * Puts a job on a cron timer. pg-boss stores the schedule in the database and one clock across
   * the cluster turns it into a job, so every worker replica may register the same schedule on
   * start without the job running twice. The call is an upsert on (name, key): re-registering an
   * existing schedule with a new expression moves it rather than adding a second one.
   */
  async schedule<N extends JobName>(
    name: N,
    cron: string,
    payload: JobPayload<N>,
    options?: ScheduleOptions,
  ): Promise<void> {
    JOBS[name].schema.parse(payload);
    await this.boss.schedule(name, cron, payload, {
      tz: options?.tz ?? "UTC",
      ...(options?.key ? { key: options.key } : {}),
    });
  }

  /** Removes a schedule registered by {@link schedule}. */
  async unschedule(name: JobName, key?: string): Promise<void> {
    await this.boss.unschedule(name, key);
  }

  /** Registers a typed handler; payloads are validated before the handler runs. */
  async consume<N extends JobName>(
    name: N,
    handler: (payload: JobPayload<N>, jobId: string) => Promise<void>,
    concurrency = 2,
    onError?: (jobId: string, error: unknown) => void,
  ): Promise<void> {
    await this.boss.work<unknown>(name, { batchSize: concurrency }, async (jobs: Job<unknown>[]) => {
      for (const job of jobs) {
        try {
          const payload = JOBS[name].schema.parse(job.data) as JobPayload<N>;
          await handler(payload, job.id);
        } catch (err) {
          // Surface the failure (pg-boss keeps it only in the job row), then let it retry.
          onError?.(job.id, err);
          throw err;
        }
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

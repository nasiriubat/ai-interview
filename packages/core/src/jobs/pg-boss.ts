import { PgBoss, type JobWithMetadata } from "pg-boss";
import {
  DEAD_LETTER_RETENTION_DAYS,
  JOBS,
  type JobName,
  type JobPayload,
  type JobPublisher,
  type ScheduleOptions,
} from "./definitions.js";

/** What a consumer learns about a failed attempt, beyond the error itself. */
export interface JobFailure {
  /** 1 for the first attempt. */
  attempt: number;
  retryLimit: number;
  /** True when no retry follows: the job is about to be dead-lettered (D-92). */
  final: boolean;
  /** The raw payload, which may not have passed validation; read ids defensively. */
  data: unknown;
}

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
      // The operator needs time to look at a dead letter, so the retention is long.
      await this.boss.createQueue(`${name}.dead`, {
        retentionSeconds: DEAD_LETTER_RETENTION_DAYS * 86_400,
      });
      const policy = {
        retryLimit: def.retryLimit,
        retryBackoff: true,
        retryDelay: 5,
        expireInSeconds: def.expireInSeconds,
      };
      await this.boss.createQueue(name, { ...policy, deadLetter: `${name}.dead` });
      // createQueue leaves an existing queue as it was. Without this a changed expireInSeconds
      // only reaches a database created after the change, which is the one nobody is running.
      await this.boss.updateQueue(name, policy);
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
    await this.boss.send(name, payload, {
      expireInSeconds: JOBS[name].expireInSeconds,
      ...(options?.singletonKey ? { singletonKey: options.singletonKey } : {}),
    });
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
      expireInSeconds: JOBS[name].expireInSeconds,
    });
  }

  /** Removes a schedule registered by {@link schedule}. */
  async unschedule(name: JobName, key?: string): Promise<void> {
    await this.boss.unschedule(name, key);
  }

  /**
   * Registers a typed handler; payloads are validated before the handler runs.
   *
   * `onError` hears every failed attempt. Its third argument says whether this was the last one:
   * after it the job is moved to `<name>.dead` and nothing else will ever report it, which is why
   * the worker raises `job.dead_lettered` from there (D-92). A job that dies by expiry (the
   * process was killed, the handler hung) never reaches this catch; the health sweep covers that.
   */
  async consume<N extends JobName>(
    name: N,
    handler: (payload: JobPayload<N>, jobId: string) => Promise<void>,
    concurrency = 2,
    onError?: (jobId: string, error: unknown, failure: JobFailure) => void,
  ): Promise<void> {
    await this.boss.work<unknown, unknown, { batchSize: number; includeMetadata: true }>(
      name,
      { batchSize: concurrency, includeMetadata: true },
      async (jobs: JobWithMetadata<unknown>[]) => {
        for (const job of jobs) {
          try {
            const payload = JOBS[name].schema.parse(job.data) as JobPayload<N>;
            await handler(payload, job.id);
          } catch (err) {
            // Surface the failure (pg-boss keeps it only in the job row), then let it retry.
            onError?.(job.id, err, {
              attempt: job.retryCount + 1,
              retryLimit: job.retryLimit,
              final: job.retryCount >= job.retryLimit,
              data: job.data,
            });
            throw err;
          }
        }
      },
    );
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

import { PgBoss, type JobResult, type JobWithMetadata } from "pg-boss";
import {
  DEAD_LETTER_RETENTION_DAYS,
  JOBS,
  type JobName,
  type JobPayload,
  type JobPublisher,
  type ScheduleOptions,
} from "./definitions.js";

/** The slice of a pg-boss job that batch settlement reads. */
export interface BatchJob {
  id: string;
  data: unknown;
  /** From pg-boss job metadata; absent in tests that do not care about attempts. */
  retryCount?: number;
  retryLimit?: number;
  /** Aborted by pg-boss when the job expires or the worker is stopped past its grace period. */
  signal?: AbortSignal;
}

/**
 * Runs one fetched batch with every job in parallel and reports each one's outcome.
 *
 * This replaces a sequential loop that threw on the first failure. Two things were wrong with it:
 * a concurrency of 4 ran one job at a time, and when job 2 threw the whole batch was failed, so
 * job 1, which had already succeeded and sent its email or called its model, was retried too.
 *
 * Each job now settles on its own (pg-boss `perJobResults`): a handler that throws fails that job
 * alone, a payload that does not parse goes straight to the dead-letter queue because no retry
 * can fix it, and the others complete. Tenant context is per async chain (AsyncLocalStorage), so
 * parallel jobs for different tenants do not see each other's.
 */
export async function runBatch<N extends JobName>(
  name: N,
  jobs: BatchJob[],
  handler: (payload: JobPayload<N>, jobId: string, signal?: AbortSignal) => Promise<void>,
  hooks: {
    onError?: ((jobId: string, error: unknown, failure: JobFailure) => void) | undefined;
    onStart?: ((jobId: string) => void) | undefined;
    onSettle?: ((jobId: string) => void) | undefined;
  } = {},
): Promise<JobResult[]> {
  return Promise.all(
    jobs.map(async (job): Promise<JobResult> => {
      hooks.onStart?.(job.id);
      try {
        const parsed = JOBS[name].schema.safeParse(job.data);
        if (!parsed.success) {
          // No retry can fix a payload that does not parse, so this attempt is the last.
          hooks.onError?.(job.id, parsed.error, failure(job, true));
          return { id: job.id, status: "deadletter", output: { message: "payload failed validation" } };
        }
        await handler(parsed.data as JobPayload<N>, job.id, job.signal);
        return { id: job.id, status: "completed" };
      } catch (err) {
        // Surface the failure (pg-boss keeps it only in the job row), then let the queue retry it.
        hooks.onError?.(job.id, err, failure(job, false));
        return {
          id: job.id,
          status: "failed",
          output: { message: err instanceof Error ? err.message : String(err) },
        };
      } finally {
        hooks.onSettle?.(job.id);
      }
    }),
  );
}

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

function failure(job: BatchJob, unrecoverable: boolean): JobFailure {
  const retryCount = job.retryCount ?? 0;
  const retryLimit = job.retryLimit ?? 0;
  return {
    attempt: retryCount + 1,
    retryLimit,
    final: unrecoverable || retryCount >= retryLimit,
    data: job.data,
  };
}

/** pg-boss publisher and consumer helpers. One queue per job name, created on start. */
export class BossJobs implements JobPublisher {
  readonly boss: PgBoss;
  /** `name:id` of every job a handler is currently running, for the shutdown log. */
  private readonly running = new Set<string>();

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

  /**
   * Stops fetching and waits for running jobs. `timeoutMs` is the grace period; jobs still running
   * when it passes are aborted through their signal and redelivered by the queue.
   */
  async stop(options: { timeoutMs?: number } = {}): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: options.timeoutMs ?? 10_000 });
  }

  /** Jobs a handler is running right now, as `queue:jobId`. */
  inFlight(): string[] {
    return [...this.running];
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
   * Registers a typed handler. Up to `concurrency` jobs are fetched together and run in parallel;
   * payloads are validated before the handler runs, and each job succeeds or fails on its own.
   *
   * `onError` hears every failed attempt. Its third argument says whether this was the last one:
   * after it the job is moved to `<name>.dead` and nothing else will ever report it, which is why
   * the worker raises `job.dead_lettered` from there (D-92). A job that dies by expiry (the
   * process was killed, the handler hung) never reaches this catch; the health sweep covers that.
   */
  async consume<N extends JobName>(
    name: N,
    handler: (payload: JobPayload<N>, jobId: string, signal?: AbortSignal) => Promise<void>,
    concurrency = 2,
    onError?: (jobId: string, error: unknown, failure: JobFailure) => void,
  ): Promise<void> {
    await this.boss.work<
      unknown,
      JobResult[],
      { batchSize: number; perJobResults: true; includeMetadata: true }
    >(
      name,
      { batchSize: concurrency, perJobResults: true, includeMetadata: true },
      (jobs: JobWithMetadata<unknown>[]) =>
        runBatch(name, jobs, handler, {
          onError,
          onStart: (id) => this.running.add(`${name}:${id}`),
          onSettle: (id) => this.running.delete(`${name}:${id}`),
        }),
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

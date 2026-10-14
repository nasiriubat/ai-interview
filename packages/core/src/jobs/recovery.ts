/**
 * Recovery of jobs whose worker died (D-281).
 *
 * pg-boss fails an `active` job only when its `expireInSeconds` passes, which for `analysis.run` is
 * an hour. A worker killed outright (the OOM killer, a reboot, `kill -9`) leaves what it was
 * running `active`, and nothing in a restarted process knows which jobs those were: a job row has
 * no owner. This adds the owner, in two small tables beside the queue's own:
 *
 * - `pgboss.aidp_worker_lease`: one row per worker process, refreshed every few seconds while it
 *   lives. A worker that is gone stops refreshing, and its row goes stale.
 * - `pgboss.aidp_job_claim`: which worker is running which job, written when a handler starts and
 *   deleted when it settles.
 *
 * A job is reclaimed only when it is `active`, a claim names a worker, and that worker's lease is
 * stale (or absent). A job with no claim is never touched, and neither is one held by a live
 * worker, so several workers can run this at once and a slow job on a healthy worker is left
 * alone. The claim is deleted before the job is failed, so two workers reclaiming the same job
 * fail it once (failing a job that is already waiting for a retry would spend another attempt).
 *
 * Failing a job gives it exactly what expiry would have: a retry with backoff while attempts
 * remain, the dead letter after. Handlers are idempotent, as they must be for expiry to be safe.
 * The tables live in the queue's schema, not the application's: they describe the queue.
 */

/** A lease not refreshed for this long belongs to a worker that is gone. */
export const LEASE_TTL_SECONDS = 45;
/** How often a live worker refreshes its lease and looks for dead workers' jobs. */
export const LEASE_BEAT_SECONDS = 15;

/** The slice of pg-boss this needs: one SQL call and the `fail` verb. */
export interface RecoveryBoss {
  getDb(): { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
  fail(name: string, id: string | string[], data?: object | null): Promise<unknown>;
}

export interface RecoveryLog {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ReclaimedJob {
  queue: string;
  jobId: string;
  workerId: string;
}

export class JobRecovery {
  private timer: NodeJS.Timeout | undefined;
  private ready = false;

  constructor(
    private readonly boss: RecoveryBoss,
    readonly workerId: string,
    private readonly log: RecoveryLog = { info: () => undefined, warn: () => undefined },
    private readonly ttlSeconds = LEASE_TTL_SECONDS,
  ) {}

  private sql(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    return this.boss.getDb().executeSql(text, values);
  }

  /** Creates the tables if they are missing and takes this worker's lease. False when it could not. */
  async start(): Promise<boolean> {
    try {
      await this.sql(`create table if not exists pgboss.aidp_worker_lease (
        worker_id text primary key,
        started_at timestamptz not null default now(),
        beat_at timestamptz not null default now()
      )`);
      await this.sql(`create table if not exists pgboss.aidp_job_claim (
        job_id uuid primary key,
        queue text not null,
        worker_id text not null,
        claimed_at timestamptz not null default now()
      )`);
      await this.sql(`create index if not exists aidp_job_claim_worker on pgboss.aidp_job_claim (worker_id)`);
      await this.beat();
      this.ready = true;
      return true;
    } catch (err) {
      // Without the tables nothing is claimed and nothing is reclaimed: the queue's own expiry
      // still applies, which is the behaviour before this existed.
      this.log.warn("job recovery disabled: could not prepare its tables", { err: String(err) });
      return false;
    }
  }

  /** Refreshes this worker's lease. */
  async beat(): Promise<void> {
    await this.sql(
      `insert into pgboss.aidp_worker_lease (worker_id) values ($1)
         on conflict (worker_id) do update set beat_at = now()`,
      [this.workerId],
    );
  }

  /** Records that this worker is running the job. Best effort: a failure only costs the quick recovery. */
  async claim(queue: string, jobId: string): Promise<void> {
    if (!this.ready) return;
    try {
      await this.sql(
        `insert into pgboss.aidp_job_claim (job_id, queue, worker_id) values ($1::uuid, $2, $3)
           on conflict (job_id) do update set queue = excluded.queue, worker_id = excluded.worker_id,
                                              claimed_at = now()`,
        [jobId, queue, this.workerId],
      );
    } catch (err) {
      this.log.warn("job claim not recorded", { jobId, err: String(err) });
    }
  }

  /** The job has settled on this worker (completed, failed or abandoned by it). */
  async release(jobId: string): Promise<void> {
    if (!this.ready) return;
    try {
      await this.sql(`delete from pgboss.aidp_job_claim where job_id = $1::uuid and worker_id = $2`, [
        jobId,
        this.workerId,
      ]);
    } catch (err) {
      this.log.warn("job claim not released", { jobId, err: String(err) });
    }
  }

  /**
   * Fails the active jobs claimed by workers whose lease has gone stale, so the queue retries them
   * now instead of when they expire. Returns what it reclaimed.
   */
  async reclaim(): Promise<ReclaimedJob[]> {
    if (!this.ready) return [];
    const orphaned = (
      await this.sql(
        `select c.job_id::text as job_id, c.queue, c.worker_id
           from pgboss.aidp_job_claim c
           join pgboss.job j on j.id = c.job_id and j.name = c.queue and j.state = 'active'
          where c.worker_id <> $1
            and not exists (
              select 1 from pgboss.aidp_worker_lease l
               where l.worker_id = c.worker_id
                 and l.beat_at > now() - ($2::int * interval '1 second'))`,
        [this.workerId, this.ttlSeconds],
      )
    ).rows as { job_id: string; queue: string; worker_id: string }[];

    const reclaimed: ReclaimedJob[] = [];
    for (const row of orphaned) {
      // Whoever deletes the claim owns the failing; a second worker finds nothing to delete.
      const won = (
        await this.sql(
          `delete from pgboss.aidp_job_claim where job_id = $1::uuid and worker_id = $2 returning job_id`,
          [row.job_id, row.worker_id],
        )
      ).rows;
      if (won.length === 0) continue;
      try {
        await this.boss.fail(row.queue, row.job_id, {
          message: `worker ${row.worker_id} stopped without finishing this job; reclaimed by ${this.workerId}`,
        });
        reclaimed.push({ queue: row.queue, jobId: row.job_id, workerId: row.worker_id });
        this.log.info("reclaimed a job from a worker that is gone", {
          queue: row.queue,
          jobId: row.job_id,
          deadWorker: row.worker_id,
        });
      } catch (err) {
        this.log.warn("could not fail a reclaimed job", { jobId: row.job_id, err: String(err) });
      }
    }
    // Housekeeping: claims whose job is no longer active, and leases of workers long gone.
    await this.sql(
      `delete from pgboss.aidp_job_claim c
        where c.claimed_at < now() - interval '2 minutes'
          and not exists (select 1 from pgboss.job j where j.id = c.job_id and j.state = 'active')`,
    );
    await this.sql(`delete from pgboss.aidp_worker_lease where beat_at < now() - interval '1 day'`);
    return reclaimed;
  }

  /** Beats and reclaims now, then on an interval. Errors are logged; the loop carries on. */
  startLoop(intervalSeconds = LEASE_BEAT_SECONDS): void {
    const tick = async (): Promise<void> => {
      try {
        await this.beat();
        await this.reclaim();
      } catch (err) {
        this.log.warn("job recovery pass failed", { err: String(err) });
      }
    };
    void tick();
    this.timer = setInterval(() => {
      void tick();
    }, intervalSeconds * 1000);
    this.timer.unref();
  }

  /**
   * Stops the loop and gives this worker's lease and claims up. What a worker drained cleanly has
   * settled; what it abandoned at the end of the grace period is reclaimed by the next start.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.ready) return;
    try {
      await this.sql(`delete from pgboss.aidp_worker_lease where worker_id = $1`, [this.workerId]);
    } catch (err) {
      this.log.warn("worker lease not released", { err: String(err) });
    }
  }
}

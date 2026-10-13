import { Prisma, type PrismaClient } from "@prisma/client";
import type { PgBoss } from "pg-boss";
import { JOBS, RUN_NOW_JOBS, type JobName } from "./definitions.js";

export interface QueueSummary {
  name: JobName;
  queued: number;
  active: number;
  deadLettered: number;
  oldestQueuedAt: string | null;
  expireInSeconds: number;
  retryLimit: number;
  /** When the newest dead letter in this queue arrived. */
  lastFailure: { at: string; jobId: string } | null;
  /** The job takes no payload, so the operator may start it by hand. */
  runNow: boolean;
}

export interface DeadJob {
  id: string;
  queue: JobName;
  createdAt: string;
  /** The id the job had in its own queue; the alert key is built from it. */
  sourceId: string | null;
  retryCount: number;
  /** The tenant the job belonged to, when the payload says so. */
  companyId: string | null;
  /** Identifiers from the payload and nothing else: no addresses, subjects or text. */
  data: Record<string, string>;
  /** The error message the last attempt ended with, shortened. */
  error: string;
}

export interface StuckJobs {
  name: string;
  count: number;
}

/**
 * Everything the operator can do to the queue, behind one port (D-92). The API serves it, the
 * health sweep reads it, and tests fake it, so a dead-letter retry is provable without a worker.
 */
export interface JobAdminPort {
  list(): Promise<QueueSummary[]>;
  deadLetters(queue: JobName, limit: number): Promise<DeadJob[]>;
  /** Re-queues a dead letter with a fresh attempt budget. Null when the job is not there. */
  retry(queue: JobName, id: string): Promise<{ job: DeadJob; queuedAs: string | null } | null>;
  /** Deletes a dead letter. Null when the job is not there. */
  discard(queue: JobName, id: string): Promise<{ job: DeadJob } | null>;
  /** Jobs active well past their expiry, which pg-boss's own maintenance should already have failed. */
  stuck(): Promise<StuckJobs[]>;
}

/** A dead letter's identifying keys only; everything else in a payload is somebody's text. */
const SAFE_KEY = /^(?:[a-z]+Id|id)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID = 80;
const MAX_ERROR = 500;
/** How long past its own expiry a job must be active before it counts as stuck. */
export const STUCK_GRACE_MINUTES = 5;

export function safePayload(data: unknown): { ids: Record<string, string>; companyId: string | null } {
  const ids: Record<string, string> = {};
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) {
      if (SAFE_KEY.test(k) && typeof v === "string" && v.length <= MAX_ID) ids[k] = v;
    }
  }
  return { ids, companyId: ids.companyId ?? null };
}

function errorText(output: unknown): string {
  if (output && typeof output === "object" && "message" in output) {
    const m = output.message;
    if (typeof m === "string") return m.replace(/\s+/g, " ").slice(0, MAX_ERROR);
  }
  return typeof output === "string" ? output.slice(0, MAX_ERROR) : "";
}

/** The real thing: pg-boss for the verbs, one read-only query over its table for what it does not expose. */
export class PgBossJobAdmin implements JobAdminPort {
  constructor(
    private readonly boss: PgBoss,
    private readonly db: PrismaClient,
  ) {}

  async list(): Promise<QueueSummary[]> {
    const names = Object.keys(JOBS) as JobName[];
    const oldest = await this.db.$queryRaw<{ name: string; oldest: Date | null }[]>(
      Prisma.sql`select name, min(created_on) as oldest from pgboss.job
                  where name = any(${names}::text[]) and state in ('created', 'retry')
                  group by name`,
    );
    const lastDead = await this.db.$queryRaw<{ name: string; id: string; created_on: Date }[]>(
      Prisma.sql`select distinct on (name) name, id::text as id, created_on from pgboss.job
                  where name = any(${names.map((n) => `${n}.dead`)}::text[])
                  order by name, created_on desc`,
    );
    const out: QueueSummary[] = [];
    for (const name of names) {
      const q = (await this.boss.getQueueStats(name)).at(-1);
      const d = (await this.boss.getQueueStats(`${name}.dead`)).at(-1);
      const last = lastDead.find((r) => r.name === `${name}.dead`);
      const first = oldest.find((r) => r.name === name)?.oldest ?? null;
      out.push({
        name,
        queued: q?.queuedCount ?? 0,
        active: q?.activeCount ?? 0,
        deadLettered: (d?.queuedCount ?? 0) + (d?.activeCount ?? 0),
        oldestQueuedAt: first ? first.toISOString() : null,
        expireInSeconds: JOBS[name].expireInSeconds,
        retryLimit: JOBS[name].retryLimit,
        lastFailure: last ? { at: last.created_on.toISOString(), jobId: last.id } : null,
        runNow: RUN_NOW_JOBS.includes(name),
      });
    }
    return out;
  }

  async deadLetters(queue: JobName, limit: number): Promise<DeadJob[]> {
    const rows = await this.db.$queryRaw<
      {
        id: string;
        created_on: Date;
        data: unknown;
        output: unknown;
        retry_count: number;
        source_id: string | null;
      }[]
    >(
      Prisma.sql`select id::text as id, created_on, data, output, retry_count, source_id::text as source_id
                   from pgboss.job where name = ${`${queue}.dead`}
                  order by created_on desc limit ${Math.min(Math.max(limit, 1), 200)}`,
    );
    return rows.map((r) => this.toDead(queue, r));
  }

  async retry(queue: JobName, id: string): Promise<{ job: DeadJob; queuedAs: string | null } | null> {
    const found = await this.find(queue, id);
    if (!found) return null;
    const queuedAs = await this.boss.send(queue, found.data as object, {
      expireInSeconds: JOBS[queue].expireInSeconds,
    });
    // Only after it is safely queued: deleting first would lose the job if the send failed.
    if (queuedAs !== null) await this.boss.deleteJob(`${queue}.dead`, id);
    return { job: found.job, queuedAs };
  }

  async discard(queue: JobName, id: string): Promise<{ job: DeadJob } | null> {
    const found = await this.find(queue, id);
    if (!found) return null;
    await this.boss.deleteJob(`${queue}.dead`, id);
    return { job: found.job };
  }

  async stuck(): Promise<StuckJobs[]> {
    const names = Object.keys(JOBS);
    return this.db.$queryRaw<StuckJobs[]>(
      Prisma.sql`select name, count(*)::int as count from pgboss.job
                  where name = any(${names}::text[]) and state = 'active'
                    and started_on < now() - (expire_seconds * interval '1 second')
                                           - (${STUCK_GRACE_MINUTES} * interval '1 minute')
                  group by name`,
    );
  }

  private async find(queue: JobName, id: string): Promise<{ job: DeadJob; data: unknown } | null> {
    // pg-boss ids are uuids and Postgres throws on anything else, which would be a 500 for a typo.
    if (!UUID.test(id)) return null;
    const job = (await this.boss.findJobs<object>(`${queue}.dead`, { id }))[0];
    if (!job) return null;
    return {
      data: job.data,
      job: this.toDead(queue, {
        id: job.id,
        created_on: job.createdOn,
        data: job.data,
        output: job.output,
        retry_count: job.retryCount,
        source_id: job.sourceId,
      }),
    };
  }

  private toDead(
    queue: JobName,
    r: {
      id: string;
      created_on: Date;
      data: unknown;
      output: unknown;
      retry_count: number;
      source_id: string | null;
    },
  ): DeadJob {
    const { ids, companyId } = safePayload(r.data);
    return {
      id: r.id,
      queue,
      createdAt: r.created_on.toISOString(),
      sourceId: r.source_id,
      retryCount: r.retry_count,
      companyId,
      data: ids,
      error: errorText(r.output),
    };
  }
}

/** The fake: seeded by a test, and what the API's test world runs against. */
export class MemoryJobAdmin implements JobAdminPort {
  readonly dead = new Map<JobName, (DeadJob & { raw: unknown })[]>();
  readonly requeued: { queue: JobName; data: unknown }[] = [];
  readonly discarded: string[] = [];
  stuckJobs: StuckJobs[] = [];
  /** Set to make `retry` fail the way a singleton conflict does: nothing queued, nothing deleted. */
  refuseRequeue = false;

  addDead(queue: JobName, job: Partial<DeadJob> & { id: string; raw?: unknown }): DeadJob {
    const raw = job.raw ?? {};
    const { ids, companyId } = safePayload(raw);
    const full: DeadJob & { raw: unknown } = {
      queue,
      createdAt: new Date().toISOString(),
      sourceId: null,
      retryCount: JOBS[queue].retryLimit,
      companyId,
      data: ids,
      error: "",
      ...job,
      raw,
    };
    const list = this.dead.get(queue) ?? [];
    list.push(full);
    this.dead.set(queue, list);
    return full;
  }

  async list(): Promise<QueueSummary[]> {
    return (Object.keys(JOBS) as JobName[]).map((name) => {
      const dead = this.dead.get(name) ?? [];
      return {
        name,
        queued: 0,
        active: 0,
        deadLettered: dead.length,
        oldestQueuedAt: null,
        expireInSeconds: JOBS[name].expireInSeconds,
        retryLimit: JOBS[name].retryLimit,
        lastFailure: dead[0] ? { at: dead[0].createdAt, jobId: dead[0].id } : null,
        runNow: RUN_NOW_JOBS.includes(name),
      };
    });
  }

  async deadLetters(queue: JobName, limit: number): Promise<DeadJob[]> {
    return (this.dead.get(queue) ?? []).slice(0, limit).map(({ raw: _raw, ...job }) => job);
  }

  async retry(queue: JobName, id: string): Promise<{ job: DeadJob; queuedAs: string | null } | null> {
    const list = this.dead.get(queue) ?? [];
    const i = list.findIndex((j) => j.id === id);
    const found = list[i];
    if (!found) return null;
    const { raw, ...job } = found;
    if (this.refuseRequeue) return { job, queuedAs: null };
    this.requeued.push({ queue, data: raw });
    list.splice(i, 1);
    return { job, queuedAs: `requeued-${id}` };
  }

  async discard(queue: JobName, id: string): Promise<{ job: DeadJob } | null> {
    const list = this.dead.get(queue) ?? [];
    const i = list.findIndex((j) => j.id === id);
    const found = list[i];
    if (!found) return null;
    list.splice(i, 1);
    this.discarded.push(id);
    const { raw: _raw, ...job } = found;
    return { job };
  }

  async stuck(): Promise<StuckJobs[]> {
    return this.stuckJobs;
  }
}

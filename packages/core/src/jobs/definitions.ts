import { z } from "zod";

/**
 * Every background job: name, payload schema, retry policy and how long one attempt may run.
 * Shared by publisher (API) and consumers (worker).
 *
 * `expireInSeconds` is the time pg-boss lets an attempt stay active before it fails it and retries
 * (D-92). The library default is 15 minutes, which redelivered a long `analysis.run` while the first
 * attempt was still working, so the report was built twice and billed twice. Each value is the
 * job's honest worst case with headroom, and a handler that outlives it is by definition stuck.
 */
export const JOBS = {
  "session.summarize": {
    schema: z.object({ sessionId: z.string(), companyId: z.string() }),
    retryLimit: 3,
    expireInSeconds: 120,
  },
  "session.extract": {
    schema: z.object({ sessionId: z.string(), companyId: z.string() }),
    retryLimit: 3,
    expireInSeconds: 180,
  },
  "email.send": {
    schema: z.object({
      to: z.string(),
      subject: z.string(),
      text: z.string(),
      html: z.string().optional(),
      companyId: z.string().optional(),
      /**
       * What makes this message the same message on a retry: purpose plus target, such as
       * `invite:${invitationId}` or `completion:${sessionId}`. Required, so a producer cannot
       * forget it and quietly lose the send-once guarantee (D-105).
       */
      idempotencyKey: z.string().min(1),
    }),
    retryLimit: 5,
    expireInSeconds: 60,
  },
  "privacy.delete-session": {
    schema: z.object({ sessionId: z.string(), companyId: z.string() }),
    retryLimit: 5,
    expireInSeconds: 300,
  },
  /** Sweeps every tenant; the payload is empty so a cron tick needs no arguments (spec 11, retention). */
  "privacy.retention-sweep": { schema: z.object({}), retryLimit: 2, expireInSeconds: 1800 },
  "auth.prune-verification-tokens": { schema: z.object({}), retryLimit: 2, expireInSeconds: 120 },
  /**
   * Reads an uploaded file: extraction or a vision call, then a summary, chunks and embeddings
   * (FR-31). Retried twice because the expensive half is two model calls, and a provider that is
   * down for a third attempt will still be down; the attachment is marked failed instead, which
   * the participant can see and act on.
   */
  "attachment.ingest": {
    schema: z.object({ attachmentId: z.string(), companyId: z.string() }),
    retryLimit: 2,
    expireInSeconds: 600,
  },
  "analysis.run": {
    schema: z.object({ analysisId: z.string(), companyId: z.string() }),
    retryLimit: 2,
    expireInSeconds: 3600,
  },
  "spec.generate": {
    schema: z.object({ versionId: z.string(), companyId: z.string() }),
    retryLimit: 2,
    expireInSeconds: 1800,
  },
  /**
   * The sweep that makes "nothing fails silently" true (D-92): reads the queue, the backup status
   * file, the disk and the provider error rate, and raises or resolves the alerts they imply.
   * One retry only: the next tick is five minutes away and is the better retry.
   */
  "ops.health-sweep": { schema: z.object({}), retryLimit: 1, expireInSeconds: 240 },
  /**
   * Walks every tenant's audit chain and writes the chain heads to the log (A2, D-163). A broken
   * chain fails the job, which dead-letters and is raised by the health sweep like any other.
   */
  "audit.verify": { schema: z.object({}), retryLimit: 1, expireInSeconds: 900 },
  /**
   * Re-encrypts every stored secret under the active platform key (P9, D-164). Started by the
   * operator after a key rotation; idempotent, so a second run finishes what a crashed one began.
   */
  "crypto.rekey": { schema: z.object({}), retryLimit: 1, expireInSeconds: 900 },
} as const;

/** How long a dead-lettered job is kept for the operator to look at before pg-boss drops it. */
export const DEAD_LETTER_RETENTION_DAYS = 30;

export type JobName = keyof typeof JOBS;
export type JobPayload<N extends JobName> = z.infer<(typeof JOBS)[N]["schema"]>;

export interface ScheduleOptions {
  /** IANA time zone the cron expression is read in. Defaults to UTC. */
  tz?: string;
  /** Distinguishes several schedules of the same job; one schedule per (name, key). */
  key?: string;
}

export interface JobPublisher {
  publish<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options?: { singletonKey?: string },
  ): Promise<void>;

  /**
   * Registers a recurring job. Upserted on (name, key), so calling it on every worker start is
   * idempotent and a second replica re-registering the same schedule does not double-run it.
   */
  schedule<N extends JobName>(
    name: N,
    cron: string,
    payload: JobPayload<N>,
    options?: ScheduleOptions,
  ): Promise<void>;
}

/**
 * Jobs the worker puts on a timer at start. Off-the-hour minutes so a deployment's sweeps do not
 * all fire together with everything else scheduled at :00.
 */
export const RECURRING_JOBS: {
  [N in JobName]?: { cron: string; payload: JobPayload<N>; tz: string };
} = {
  "privacy.retention-sweep": { cron: "17 3 * * *", payload: {}, tz: "UTC" },
  // Sign-in tokens expire in minutes; a sweep on sign-in traffic alone leaves rows behind on a
  // quiet week, so they also get their own hour.
  "auth.prune-verification-tokens": { cron: "42 4 * * *", payload: {}, tz: "UTC" },
  // Every five minutes: the longest a dead disk, a stuck queue or a failed backup waits before the
  // operator is told. `expireInSeconds` (240) keeps one tick from overlapping the next.
  "ops.health-sweep": { cron: "*/5 * * * *", payload: {}, tz: "UTC" },
  // Daily, after the retention sweep: its heads are the values to copy into the backup log.
  "audit.verify": { cron: "27 5 * * *", payload: {}, tz: "UTC" },
};

/**
 * Jobs an operator may start by hand from the jobs page (D-92): the parameterless recurring ones,
 * where "run it now" is a button instead of a `psql` session. A job that needs ids in its payload
 * is deliberately not here.
 */
export const RUN_NOW_JOBS = Object.keys(RECURRING_JOBS) as JobName[];

/** Collects jobs in memory: tests, and dry runs. */
export class MemoryJobPublisher implements JobPublisher {
  readonly published: { name: JobName; payload: unknown; singletonKey?: string }[] = [];
  readonly scheduled: { name: JobName; cron: string; payload: unknown; options?: ScheduleOptions }[] = [];

  async publish<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options?: { singletonKey?: string },
  ): Promise<void> {
    JOBS[name].schema.parse(payload);
    this.published.push({
      name,
      payload,
      ...(options?.singletonKey ? { singletonKey: options.singletonKey } : {}),
    });
  }

  async schedule<N extends JobName>(
    name: N,
    cron: string,
    payload: JobPayload<N>,
    options?: ScheduleOptions,
  ): Promise<void> {
    JOBS[name].schema.parse(payload);
    const key = options?.key ?? "";
    const existing = this.scheduled.findIndex((s) => s.name === name && (s.options?.key ?? "") === key);
    const entry = { name, cron, payload, ...(options ? { options } : {}) };
    if (existing >= 0) this.scheduled[existing] = entry;
    else this.scheduled.push(entry);
  }
}

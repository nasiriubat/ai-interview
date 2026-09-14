import { z } from "zod";

/** Every background job: name, payload schema, retry policy. Shared by publisher (API) and consumers (worker). */
export const JOBS = {
  "session.summarize": { schema: z.object({ sessionId: z.string(), companyId: z.string() }), retryLimit: 3 },
  "session.extract": { schema: z.object({ sessionId: z.string(), companyId: z.string() }), retryLimit: 3 },
  "email.send": {
    schema: z.object({
      to: z.string(),
      subject: z.string(),
      text: z.string(),
      html: z.string().optional(),
      companyId: z.string().optional(),
    }),
    retryLimit: 5,
  },
  "privacy.delete-session": {
    schema: z.object({ sessionId: z.string(), companyId: z.string() }),
    retryLimit: 5,
  },
  /** Sweeps every tenant; the payload is empty so a cron tick needs no arguments (spec 11, retention). */
  "privacy.retention-sweep": { schema: z.object({}), retryLimit: 2 },
  "analysis.run": { schema: z.object({ analysisId: z.string(), companyId: z.string() }), retryLimit: 2 },
  "spec.generate": { schema: z.object({ versionId: z.string(), companyId: z.string() }), retryLimit: 2 },
} as const;

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
};

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

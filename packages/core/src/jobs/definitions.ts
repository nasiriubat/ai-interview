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
} as const;

export type JobName = keyof typeof JOBS;
export type JobPayload<N extends JobName> = z.infer<(typeof JOBS)[N]["schema"]>;

export interface JobPublisher {
  publish<N extends JobName>(
    name: N,
    payload: JobPayload<N>,
    options?: { singletonKey?: string },
  ): Promise<void>;
}

/** Collects jobs in memory: tests, and dry runs. */
export class MemoryJobPublisher implements JobPublisher {
  readonly published: { name: JobName; payload: unknown; singletonKey?: string }[] = [];
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
}

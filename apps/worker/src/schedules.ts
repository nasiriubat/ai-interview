import { RECURRING_JOBS, type JobName, type JobPublisher } from "@aidp/core";

/**
 * Puts every recurring job on its timer. Called on each worker start: the schedule is an upsert in
 * the queue's own tables, so replicas registering the same schedule neither duplicate it nor make
 * it run twice, and a changed cron expression takes effect on the next deploy.
 */
export async function registerSchedules(
  jobs: JobPublisher,
  log?: { info: (message: string, meta?: Record<string, unknown>) => void },
): Promise<JobName[]> {
  const registered: JobName[] = [];
  for (const [name, spec] of Object.entries(RECURRING_JOBS)) {
    const job = name as JobName;
    await jobs.schedule(job, spec.cron, spec.payload, { tz: spec.tz });
    log?.info("job scheduled", { job, cron: spec.cron, tz: spec.tz });
    registered.push(job);
  }
  return registered;
}

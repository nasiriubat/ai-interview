import { deadLetterKey, type Alert, type JobFailure, type JobName } from "@aidp/core";

/**
 * The alert for a job whose last attempt just failed (D-92).
 *
 * Only the error's class name goes in: a message can carry a prompt fragment or an address, and an
 * alert leaves the box through email and a webhook. The full error is in the worker's log, tied to
 * the same job id. The key is the failing job's own id, which becomes `sourceId` on the dead letter,
 * so the health sweep reporting the same dead letter later is the same alert, not a second one.
 */
export function deadLetterAlert(name: JobName, jobId: string, failure: JobFailure, err: unknown): Alert {
  const data = failure.data as { companyId?: unknown } | null;
  const companyId = typeof data?.companyId === "string" ? data.companyId : undefined;
  const reason = err instanceof Error ? err.name : "Error";
  return {
    kind: "job.dead_lettered",
    key: deadLetterKey(name, jobId),
    title: `Job dead-lettered: ${name}`,
    message: `A ${name} job failed its last attempt (${failure.attempt} of ${failure.retryLimit + 1}, ${reason}) and is waiting in ${name}.dead. Retry or discard it from the operator jobs page.`,
    context: {
      queue: name,
      jobId,
      attempts: failure.attempt,
      reason,
      ...(companyId ? { tenantId: companyId } : {}),
    },
    ...(companyId ? { companyId } : {}),
    // The tenant sees "analysis failed" in its own screens; this is for the person running the box.
    audience: ["operator"],
  };
}

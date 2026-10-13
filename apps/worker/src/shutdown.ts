/**
 * Graceful shutdown for the worker (D-107).
 *
 * The old handler stopped the queue with a fixed ten-second wait and then called `process.exit(0)`
 * whatever had happened, ignored a second signal, and never said which jobs it abandoned. Docker
 * sends SIGKILL after its own grace period anyway, so a job that outran the handler died without a
 * log line and with an exit code that claimed success.
 *
 * What this does instead:
 * - The first signal stops the queue fetching and gives running jobs `graceMs` to finish. pg-boss
 *   aborts the ones still running at that point and redelivers them.
 * - A second signal, from an impatient operator or an orchestrator, exits immediately.
 * - The exit code says what happened: 0 only when everything drained, 1 for a missed deadline, a
 *   failure to stop, or a forced exit. Whatever was in flight is logged.
 *
 * The side effects are passed in so the sequence can be tested without exiting the process.
 */

export interface ShutdownLog {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
}

export interface ShutdownDeps {
  /** Stops fetching and resolves when running jobs have finished or the timeout has passed. */
  stopJobs: (timeoutMs: number) => Promise<void>;
  /** Releases the database connection. Only called after a clean drain. */
  disconnect: () => Promise<void>;
  /** What is running right now, for the log. */
  inFlight: () => string[];
  exit: (code: number) => void;
  log: ShutdownLog;
  /** How long running jobs may take. */
  graceMs: number;
}

/** pg-boss aborts stragglers at the grace period; this is how much longer we wait to hear about it. */
const DEADLINE_SLACK_MS = 2_000;

export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const { stopJobs, disconnect, inFlight, exit, log, graceMs } = deps;
  let stopping = false;

  return async (signal: string): Promise<void> => {
    if (stopping) {
      log.warn({ signal, inFlight: inFlight() }, "second signal during shutdown; exiting now");
      exit(1);
      return;
    }
    stopping = true;
    log.info({ signal, graceMs, inFlight: inFlight() }, "shutting down; draining running jobs");

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => {
        resolve("deadline");
      }, graceMs + DEADLINE_SLACK_MS);
    });
    const drained = stopJobs(graceMs).then(
      () => "drained" as const,
      (err: unknown) => {
        log.error({ err }, "stopping the job queue failed");
        return "failed" as const;
      },
    );
    const outcome = await Promise.race([drained, deadline]);
    if (timer) clearTimeout(timer);

    if (outcome === "drained") {
      try {
        await disconnect();
      } catch (err) {
        log.error({ err }, "disconnecting from the database failed");
        exit(1);
        return;
      }
      log.info({}, "shutdown complete");
      exit(0);
      return;
    }
    log.error(
      { outcome, inFlight: inFlight() },
      outcome === "deadline"
        ? "jobs were still running at the shutdown deadline; they will be redelivered"
        : "shutdown did not complete cleanly",
    );
    exit(1);
  };
}

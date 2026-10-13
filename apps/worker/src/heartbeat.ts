import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface HeartbeatOptions {
  /** The file whose mtime the container healthcheck reads. */
  file: string;
  /**
   * Any cheap call that needs a live connection to the queue's database. It must reject or hang
   * when the queue is unreachable; a probe that answers from a cache would keep the file fresh
   * while the worker could do nothing, which is the failure this exists to catch.
   */
  probe: () => Promise<unknown>;
  intervalMs?: number;
  /** A probe that has not answered by then counts as failed. */
  probeTimeoutMs?: number;
  /** Consecutive failures after which the process gives up and asks to be restarted. */
  maxFailures?: number;
  /** Called once, when `maxFailures` is reached. In production this exits the process. */
  onFatal: (reason: string) => void;
  log?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export type BeatResult = "ok" | "failed" | "fatal";

/**
 * The worker's proof of life (D-92). A worker has no HTTP surface, and the healthcheck it used to
 * have, `kill -0 1`, asked whether the process existed, which is true of a worker that has lost its
 * database and is doing nothing. This asks the question that matters: can it reach the queue.
 *
 * The file is refreshed only when the probe answers. Docker never restarts a container just
 * because it is unhealthy, so after `maxFailures` consecutive failures the process exits and
 * `restart: unless-stopped` does the repair; the healthcheck then only has to make the state visible.
 */
export class Heartbeat {
  private failures = 0;
  private fatal = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: HeartbeatOptions) {}

  async beat(): Promise<BeatResult> {
    const timeoutMs = this.options.probeTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.options.probe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`queue did not answer within ${timeoutMs} ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      return this.failed(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.failures = 0;
    try {
      await mkdir(dirname(this.options.file), { recursive: true });
      await writeFile(this.options.file, `${new Date().toISOString()}\n`);
    } catch (err) {
      // The queue is fine; the volume is not. That is a deployment fault the healthcheck will
      // show, not a reason to restart a worker that is working.
      this.options.log?.error("heartbeat file could not be written", { err: String(err) });
    }
    return "ok";
  }

  private failed(err: unknown): BeatResult {
    this.failures += 1;
    const max = this.options.maxFailures ?? 3;
    this.options.log?.warn("worker: pg-boss did not answer", { failures: this.failures, err: String(err) });
    if (this.failures >= max && !this.fatal) {
      this.fatal = true;
      this.options.log?.error("worker: pg-boss unreachable, exiting for restart", {
        failures: this.failures,
      });
      this.options.onFatal(`pg-boss unreachable for ${this.failures} consecutive checks`);
      return "fatal";
    }
    return "failed";
  }

  /** Beats once now, so a fresh container is healthy as soon as it is, then on the interval. */
  async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      void this.beat();
    }, this.options.intervalMs ?? 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

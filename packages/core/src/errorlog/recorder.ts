import { sanitizeError } from "./sanitize.js";
import type { ErrorEvent, ErrorLogPort, ErrorStore, ErrorWrite } from "./types.js";

export interface ErrorRecorderOptions {
  store: ErrorStore;
  /** A group stores at most one occurrence per this window; the rest are counted (default 10 s). */
  throttleMs?: number;
  /** How long a capture waits for others before the batch is written (default 1 s). */
  flushMs?: number;
  /** Occurrences waiting to be written; past this they are counted, not kept (default 500). */
  maxQueue?: number;
  /** Groups whose throttled repeats are waiting to be counted (default 1000). */
  maxPending?: number;
  /** Where the recorder says, once, that it could not write. Never the error log itself. */
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  now?: () => number;
  /** False in tests that flush by hand; the timer is otherwise unref'd so it never holds a process open. */
  autoFlush?: boolean;
}

/**
 * Captures failures without ever touching the request that failed (D-477).
 *
 * `capture` is synchronous and cannot throw: it sanitises the event, decides whether this
 * occurrence is kept or only counted, and returns. Writing happens later, in batches, from a
 * timer. Three things keep a storm from becoming a second outage:
 *
 * - per group, at most one occurrence is stored per `throttleMs`; the others add to the count;
 * - the queue is bounded: past `maxQueue` an occurrence is counted, not stored;
 * - a failed write is dropped, not retried, and said on stdout once until a write succeeds again.
 */
export class ErrorRecorder implements ErrorLogPort {
  private readonly store: ErrorStore;
  private readonly throttleMs: number;
  private readonly flushMs: number;
  private readonly maxQueue: number;
  private readonly maxPending: number;
  private readonly warn: (message: string, meta?: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly autoFlush: boolean;

  private queue: ErrorWrite[] = [];
  /** Throttled repeats, one write per group carrying the count and the newest record. */
  private pending = new Map<string, ErrorWrite>();
  /** When each group last had an occurrence stored. */
  private readonly lastStored = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private failing = false;
  /** Occurrences that could not even be counted (both bounds full); reported with the next warning. */
  dropped = 0;

  constructor(options: ErrorRecorderOptions) {
    this.store = options.store;
    this.throttleMs = options.throttleMs ?? 10_000;
    this.flushMs = options.flushMs ?? 1_000;
    this.maxQueue = options.maxQueue ?? 500;
    this.maxPending = options.maxPending ?? 1_000;
    this.warn =
      options.warn ??
      ((message, meta) => {
        console.warn(JSON.stringify({ event: "errorlog", message, ...meta }));
      });
    this.now = options.now ?? Date.now;
    this.autoFlush = options.autoFlush ?? true;
  }

  capture(event: ErrorEvent): void {
    try {
      const at = this.now();
      const record = sanitizeError(event, new Date(at));
      const last = this.lastStored.get(record.groupKey);
      const throttled = last !== undefined && at - last < this.throttleMs;
      if (!throttled && this.queue.length < this.maxQueue) {
        this.lastStored.set(record.groupKey, at);
        this.forgetOldThrottles(at);
        this.queue.push({ record, count: 1, storeOccurrence: true });
      } else {
        const waiting = this.pending.get(record.groupKey);
        if (waiting) {
          waiting.count += 1;
          waiting.record = record;
        } else if (this.pending.size < this.maxPending) {
          this.pending.set(record.groupKey, { record, count: 1, storeOccurrence: false });
        } else {
          this.dropped += 1;
        }
      }
      this.schedule();
    } catch {
      // Reporting a failure must never become one.
    }
  }

  /** Writes everything waiting. Safe to call at any time; concurrent calls share one write. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) await this.flushing;
    if (this.queue.length === 0 && this.pending.size === 0) return;
    const batch = [...this.queue, ...this.pending.values()];
    this.queue = [];
    this.pending = new Map();
    this.flushing = this.store
      .write(batch)
      .then(() => {
        this.failing = false;
      })
      .catch((err: unknown) => {
        if (this.failing) return;
        this.failing = true;
        this.warn("could not write to the error log; failures are dropped until it works again", {
          error: err instanceof Error ? err.message : String(err),
          lost: batch.reduce((n, w) => n + w.count, 0),
          dropped: this.dropped,
        });
      })
      .finally(() => {
        this.flushing = null;
      });
    await this.flushing;
  }

  /** For shutdown: writes what is waiting, within `timeoutMs`. */
  async close(timeoutMs = 2_000): Promise<void> {
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs).unref();
      }),
    ]);
  }

  /** Waiting to be written: stored occurrences and counted repeats. */
  backlog(): { queued: number; counted: number } {
    return {
      queued: this.queue.length,
      counted: [...this.pending.values()].reduce((n, w) => n + w.count, 0),
    };
  }

  private schedule(): void {
    if (!this.autoFlush || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    this.timer.unref();
  }

  private forgetOldThrottles(now: number): void {
    if (this.lastStored.size < 5_000) return;
    for (const [key, at] of this.lastStored) if (now - at >= this.throttleMs) this.lastStored.delete(key);
  }
}

/** For tools and tests that report nowhere. */
export class NoopErrorLog implements ErrorLogPort {
  capture(): void {
    // nothing
  }
}

/** Collects sanitised writes in memory: the store tests and the API's suites assert on. */
export class MemoryErrorStore implements ErrorStore {
  readonly writes: ErrorWrite[] = [];
  fail = false;

  async write(batch: ErrorWrite[]): Promise<void> {
    if (this.fail) throw new Error("store unavailable");
    this.writes.push(...batch.map((w) => ({ ...w, record: { ...w.record } })));
  }

  /** Total occurrences counted for a group. */
  countFor(groupKey: string): number {
    return this.writes.filter((w) => w.record.groupKey === groupKey).reduce((n, w) => n + w.count, 0);
  }

  stored(): ErrorWrite[] {
    return this.writes.filter((w) => w.storeOccurrence);
  }
}

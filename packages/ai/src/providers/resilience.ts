import { ProviderError } from "./types.js";

/**
 * Outbound time limits and retries for provider adapters (D-93).
 *
 * Before this, an OpenAI-compatible call had no deadline at all (only `speak` took a signal) and
 * the Anthropic client ran on the SDK's ten-minute default with its own hidden retries. A provider
 * that accepts a connection and then says nothing held an interview turn, and its turn lock, for as
 * long as the socket lived, and nothing was reported because nothing had failed yet.
 */
export interface ProviderTimeouts {
  /** The ceiling for one attempt, streaming included. No call outlives it. */
  totalMs: number;
  /** Streaming: from the request to the first piece of output. A silent provider fails fast. */
  firstTokenMs: number;
  /** Streaming: the longest gap between pieces once output has started. */
  idleMs: number;
  /** Extra attempts after a retryable failure before any output; 0 means try once. */
  maxRetries: number;
}

export const DEFAULT_TIMEOUTS: ProviderTimeouts = {
  totalMs: 120_000,
  firstTokenMs: 20_000,
  idleMs: 30_000,
  maxRetries: 2,
};

const HARD_MAX_MS = 600_000;
const HARD_MAX_RETRIES = 5;

function intFrom(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * The limits for this process. `PROVIDER_TIMEOUT_MS` is the ceiling: the two streaming deadlines
 * are clamped under it, so one variable is enough to make a slow self-hosted gateway work and none
 * of them can be set to "forever". A garbage value falls back to the default rather than failing
 * boot, because an unreadable timeout must not take the interview down with it.
 */
export function timeoutsFromEnv(env: Record<string, string | undefined> = process.env): ProviderTimeouts {
  const totalMs = intFrom(env.PROVIDER_TIMEOUT_MS, DEFAULT_TIMEOUTS.totalMs, 1_000, HARD_MAX_MS);
  return {
    totalMs,
    firstTokenMs: Math.min(
      totalMs,
      intFrom(env.PROVIDER_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_TIMEOUTS.firstTokenMs, 500, HARD_MAX_MS),
    ),
    idleMs: Math.min(
      totalMs,
      intFrom(env.PROVIDER_IDLE_TIMEOUT_MS, DEFAULT_TIMEOUTS.idleMs, 500, HARD_MAX_MS),
    ),
    maxRetries: intFrom(env.PROVIDER_MAX_RETRIES, DEFAULT_TIMEOUTS.maxRetries, 0, HARD_MAX_RETRIES),
  };
}

/** The error every deadline ends in. Retryable: a provider that was slow once is usually not slow twice. */
export function timeoutError(what: string, ms: number, cause?: unknown): ProviderError {
  return new ProviderError(`${what} timed out after ${Math.round(ms / 1000)} s`, "timeout", true, cause);
}

/** `AbortSignal.timeout` rejects with a `TimeoutError`; a caller's own abort is an `AbortError`. */
export function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

/** Backoff before attempt `attempt` (1 is the first retry): 300 ms doubling, jittered, capped at 4 s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(4_000, 300 * 2 ** (attempt - 1));
  return Math.round(base / 2 + random() * (base / 2));
}

/** A `Retry-After` in seconds, honoured up to a cap so a hostile header cannot park a turn. */
export function retryAfterMs(header: string | null | undefined, capMs = 5_000): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(capMs, Math.round(seconds * 1000));
}

export interface GuardOptions<T> {
  firstMs: number;
  idleMs: number;
  /** Which item counts as "output has started". Everything before it is held to `firstMs`. */
  isOutput?: (item: T) => boolean;
  /** Stops the source, so a stalled provider connection is not left open behind the error. */
  abort: () => void;
  label: string;
  /** When the first-output clock started, if before this call (the request, not the response). */
  since?: number;
}

/**
 * Passes `source` through, failing it when it goes quiet. The wait for the first output item is
 * bounded by `firstMs` and every later wait by `idleMs`.
 *
 * Racing `next()` against a timer is what makes this work on a source that is simply stuck: a
 * `for await` over it would wait forever, and the deadline has to fire from outside.
 */
export async function* guardStream<T>(source: AsyncIterable<T>, o: GuardOptions<T>): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let started = false;
  const begun = o.since ?? Date.now();
  try {
    for (;;) {
      // Before output the clock runs from the request, so a stream of empty keep-alives cannot
      // restart it; after output it restarts on every item.
      const limit = started ? o.idleMs : Math.max(1, o.firstMs - (Date.now() - begun));
      let timer: NodeJS.Timeout | undefined;
      const quiet = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(timeoutError(started ? `${o.label} (no data)` : `${o.label} (first output)`, limit));
        }, limit);
      });
      let step: IteratorResult<T>;
      try {
        step = await Promise.race([iterator.next(), quiet]);
      } catch (err) {
        o.abort();
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (step.done) return;
      if (!started && (o.isOutput?.(step.value) ?? true)) started = true;
      yield step.value;
    }
  } finally {
    // Reached on a normal end, an error, and a consumer that stops early (barge-in): in each case
    // the source must be released, and a source that is stuck is released by the abort above.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

/** Waits `ms`, or rejects at once when `signal` aborts. Overridable in tests so nothing really sleeps. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

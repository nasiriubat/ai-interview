import { ProviderError } from "./types.js";

/**
 * A circuit breaker per provider (D-228).
 *
 * A provider that is failing is not helped by more requests, and a participant is not helped by
 * waiting for each of them to time out. After `failures` countable failures inside `windowMs` the
 * circuit opens and calls are refused at once (or sent to the purpose's fallback route) for
 * `openMs`; then exactly one call is let through as a probe. The probe's outcome closes the circuit
 * or re-opens it for another `openMs`.
 *
 * Only failures that say something about the provider count: timeouts, network errors, 5xx and
 * 429. A bad request, a refusal or a wrong key is the caller's problem, and opening a circuit on
 * it would take a healthy provider away from every other tenant.
 *
 * State is per process. Two processes (API and worker) each learn about an outage on their own;
 * the alert makes it visible, and a process-local breaker needs no shared store that could itself
 * be the thing that is down.
 */
export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  /** Countable failures within the window that open the circuit. Default 5. */
  failures?: number;
  /** Default 60 000. */
  windowMs?: number;
  /** How long an open circuit stays open before a probe is allowed. Default 30 000. */
  openMs?: number;
  now?: () => number;
  /** Called on every state change; used to raise `provider.circuit_open` and to export the gauge. */
  onChange?: (providerId: string, from: BreakerState, to: BreakerState) => void;
}

interface Circuit {
  state: BreakerState;
  failureAt: number[];
  openedAt: number;
  probing: boolean;
}

/** Whether a failure should count against the provider. */
export function countsAgainstProvider(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  return (
    err.code === "timeout" || err.code === "network" || err.code === "server" || err.code === "rate_limit"
  );
}

export class CircuitBreaker {
  private readonly circuits = new Map<string, Circuit>();
  private readonly failures: number;
  private readonly windowMs: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(private readonly options: BreakerOptions = {}) {
    this.failures = options.failures ?? 5;
    this.windowMs = options.windowMs ?? 60_000;
    this.openMs = options.openMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  private circuit(id: string): Circuit {
    let c = this.circuits.get(id);
    if (!c) {
      c = { state: "closed", failureAt: [], openedAt: 0, probing: false };
      this.circuits.set(id, c);
    }
    return c;
  }

  private move(id: string, c: Circuit, to: BreakerState): void {
    if (c.state === to) return;
    const from = c.state;
    c.state = to;
    this.options.onChange?.(id, from, to);
  }

  /** The state a call would meet now, without taking a probe slot. */
  state(id: string): BreakerState {
    const c = this.circuits.get(id);
    if (!c) return "closed";
    if (c.state === "open" && this.now() - c.openedAt >= this.openMs) return "half_open";
    return c.state;
  }

  /**
   * Asks to make a call. True: go ahead, and report `success` or `failure` afterwards. False: the
   * circuit is open (or its one probe is already out); use the fallback or fail fast.
   */
  tryAcquire(id: string): boolean {
    const c = this.circuit(id);
    if (c.state === "closed") return true;
    if (c.state === "open") {
      if (this.now() - c.openedAt < this.openMs) return false;
      this.move(id, c, "half_open");
      c.probing = true;
      return true;
    }
    // half_open: one probe at a time.
    if (c.probing) return false;
    c.probing = true;
    return true;
  }

  success(id: string): void {
    const c = this.circuit(id);
    c.failureAt = [];
    c.probing = false;
    this.move(id, c, "closed");
  }

  /** Reports a failure; the caller has already decided it counts (see {@link countsAgainstProvider}). */
  failure(id: string): void {
    const c = this.circuit(id);
    const at = this.now();
    if (c.state === "half_open") {
      c.probing = false;
      c.openedAt = at;
      this.move(id, c, "open");
      return;
    }
    c.failureAt = c.failureAt.filter((t) => at - t < this.windowMs);
    c.failureAt.push(at);
    if (c.state === "closed" && c.failureAt.length >= this.failures) {
      c.openedAt = at;
      this.move(id, c, "open");
    }
  }

  /** Releases a probe slot taken by a call that ended without saying anything about the provider. */
  release(id: string): void {
    const c = this.circuits.get(id);
    if (c) c.probing = false;
  }

  /** Every circuit that is not closed, for the operator's health page. */
  open(): { providerId: string; state: BreakerState; openedAt: number }[] {
    const out: { providerId: string; state: BreakerState; openedAt: number }[] = [];
    for (const [providerId, c] of this.circuits)
      if (c.state !== "closed") out.push({ providerId, state: this.state(providerId), openedAt: c.openedAt });
    return out;
  }
}

/**
 * Breaker options from the environment, so a slow gateway or a test can change them without a
 * release: `PROVIDER_CIRCUIT_FAILURES`, `PROVIDER_CIRCUIT_WINDOW_MS`, `PROVIDER_CIRCUIT_OPEN_MS`.
 * An unreadable value falls back to the default.
 */
export function breakerOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Pick<BreakerOptions, "failures" | "windowMs" | "openMs"> {
  const num = (raw: string | undefined, min: number, max: number): number | undefined => {
    const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  };
  const failures = num(env.PROVIDER_CIRCUIT_FAILURES, 1, 100);
  const windowMs = num(env.PROVIDER_CIRCUIT_WINDOW_MS, 100, 3_600_000);
  const openMs = num(env.PROVIDER_CIRCUIT_OPEN_MS, 10, 3_600_000);
  return {
    ...(failures === undefined ? {} : { failures }),
    ...(windowMs === undefined ? {} : { windowMs }),
    ...(openMs === undefined ? {} : { openMs }),
  };
}

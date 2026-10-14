/**
 * Metrics (D-222): a port, an in-process Prometheus registry that renders the text exposition
 * format, and a no-op.
 *
 * Written here rather than taken from `prom-client` because the whole surface this program needs
 * is three instrument kinds and a text renderer (about 150 lines, fully testable with no network),
 * and because the server image is sized for a 4 GB host where a dependency tree for a feature that
 * is off by default is a cost with no reader. The output is the standard text format version
 * 0.0.4, which Prometheus, Grafana Agent and VictoriaMetrics all scrape.
 *
 * Pull, not push: nothing here needs a collector, and Prometheus is the smallest thing that can
 * draw a p95. The endpoint is served on an internal port (see `metrics-server.ts`), never through
 * Caddy.
 */

export type Labels = Record<string, string>;

/** Seconds, for latency histograms of an interactive turn. */
export const TURN_BUCKETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10];
/** Seconds, for voice first word and first caption. */
export const VOICE_BUCKETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** Seconds, for jobs and model calls that may run long. */
export const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 1800];

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labelKey(labels: Labels, names: readonly string[]): string {
  return names.map((n) => `${n}=${labels[n] ?? ""}`).join("\u0000");
}

function renderLabels(names: readonly string[], values: readonly string[], extra?: string): string {
  const parts = names.map((n, i) => `${n}="${escapeLabel(values[i] ?? "")}"`);
  if (extra) parts.push(extra);
  return parts.length ? `{${parts.join(",")}}` : "";
}

interface Series {
  values: string[];
}

abstract class Instrument {
  protected readonly series = new Map<string, Series>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {}

  protected seriesFor(labels: Labels): Series {
    const key = labelKey(labels, this.labelNames);
    let s = this.series.get(key);
    if (!s) {
      s = { values: this.labelNames.map((n) => labels[n] ?? "") };
      this.series.set(key, s);
    }
    return s;
  }

  /** Forgets every series; used by gauges that are re-set from a full reading each sweep. */
  clear(): void {
    this.series.clear();
  }

  abstract type(): "counter" | "gauge" | "histogram";
  abstract lines(): string[];
}

export class Counter extends Instrument {
  private readonly counts = new Map<string, number>();
  type(): "counter" {
    return "counter";
  }
  inc(labels: Labels = {}, by = 1): void {
    const s = this.seriesFor(labels);
    const key = s.values.join("\u0000");
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }
  value(labels: Labels = {}): number {
    return this.counts.get(this.seriesFor(labels).values.join("\u0000")) ?? 0;
  }
  lines(): string[] {
    return [...this.series.values()].map(
      (s) =>
        `${this.name}${renderLabels(this.labelNames, s.values)} ${this.counts.get(s.values.join("\u0000")) ?? 0}`,
    );
  }
  override clear(): void {
    super.clear();
    this.counts.clear();
  }
}

export class Gauge extends Instrument {
  private readonly current = new Map<string, number>();
  type(): "gauge" {
    return "gauge";
  }
  set(labels: Labels, value: number): void {
    const s = this.seriesFor(labels);
    this.current.set(s.values.join("\u0000"), value);
  }
  lines(): string[] {
    return [...this.series.values()].map(
      (s) =>
        `${this.name}${renderLabels(this.labelNames, s.values)} ${this.current.get(s.values.join("\u0000")) ?? 0}`,
    );
  }
  override clear(): void {
    super.clear();
    this.current.clear();
  }
}

interface HistogramState {
  buckets: number[];
  sum: number;
  count: number;
}

export class Histogram extends Instrument {
  private readonly states = new Map<string, HistogramState>();
  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    readonly bucketBounds: readonly number[],
  ) {
    super(name, help, labelNames);
  }
  type(): "histogram" {
    return "histogram";
  }
  observe(labels: Labels, value: number): void {
    const s = this.seriesFor(labels);
    const key = s.values.join("\u0000");
    let st = this.states.get(key);
    if (!st) {
      st = { buckets: this.bucketBounds.map(() => 0), sum: 0, count: 0 };
      this.states.set(key, st);
    }
    this.bucketBounds.forEach((bound, i) => {
      if (value <= bound) st.buckets[i] = (st.buckets[i] ?? 0) + 1;
    });
    st.sum += value;
    st.count += 1;
  }
  /** Observations recorded for a label set; tests read this instead of parsing text. */
  countOf(labels: Labels = {}): number {
    return this.states.get(this.seriesFor(labels).values.join("\u0000"))?.count ?? 0;
  }
  lines(): string[] {
    const out: string[] = [];
    for (const s of this.series.values()) {
      const st = this.states.get(s.values.join("\u0000"));
      if (!st) continue;
      this.bucketBounds.forEach((bound, i) => {
        out.push(
          `${this.name}_bucket${renderLabels(this.labelNames, s.values, `le="${bound}"`)} ${st.buckets[i] ?? 0}`,
        );
      });
      out.push(`${this.name}_bucket${renderLabels(this.labelNames, s.values, 'le="+Inf"')} ${st.count}`);
      out.push(`${this.name}_sum${renderLabels(this.labelNames, s.values)} ${st.sum}`);
      out.push(`${this.name}_count${renderLabels(this.labelNames, s.values)} ${st.count}`);
    }
    return out;
  }
  override clear(): void {
    super.clear();
    this.states.clear();
  }
}

/** A set of instruments that renders itself. */
export class Registry {
  private readonly instruments = new Map<string, Instrument>();

  private add<T extends Instrument>(i: T): T {
    if (this.instruments.has(i.name)) throw new Error(`metric ${i.name} is already registered`);
    this.instruments.set(i.name, i);
    return i;
  }
  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(name, help, labelNames));
  }
  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(name, help, labelNames));
  }
  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = DURATION_BUCKETS,
  ): Histogram {
    return this.add(new Histogram(name, help, labelNames, buckets));
  }

  /** Registered metric names, for tests that check a dashboard only asks for series that exist. */
  names(): string[] {
    return [...this.instruments.keys()];
  }

  /** The Prometheus text exposition format, version 0.0.4. */
  render(): string {
    const out: string[] = [];
    for (const i of this.instruments.values()) {
      const lines = i.lines();
      if (lines.length === 0) continue;
      out.push(`# HELP ${i.name} ${i.help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`);
      out.push(`# TYPE ${i.name} ${i.type()}`);
      out.push(...lines);
    }
    return `${out.join("\n")}\n`;
  }
}

/** The numbers the platform exports. A narrow port: callers say what happened, not which series. */
export interface Metrics {
  /** A model call was recorded. Feeds first-token, duration, token, cost and error series. */
  modelCall(call: {
    purpose: string;
    provider: string;
    model: string;
    tenant: string;
    status: string;
    latencyMs: number;
    firstTokenMs?: number | undefined;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    costCents: number;
    audioSeconds?: number | undefined;
    errorCode?: string | undefined;
  }): void;
  /** A participant turn finished, `mode` being chat | options | voice. */
  turn(tenant: string, mode: string, durationMs: number): void;
  voiceFirstWord(tenant: string, mode: string, ms: number): void;
  voiceFirstPartial(tenant: string, mode: string, ms: number): void;
  voiceEvent(tenant: string, event: "interruption" | "stream_fallback"): void;
  budgetBlocked(tenant: string, scope: string): void;
  job(name: string, outcome: "ok" | "error", durationMs: number, final?: boolean): void;
  http(route: string, method: string, status: number, durationMs: number): void;
  circuit(provider: string, state: "closed" | "open" | "half_open"): void;
  alert(kind: string, severity: string, outcome: "sent" | "suppressed"): void;
  /** Point-in-time readings set by the health sweep; `oldestAgeSeconds` is 0 for an empty queue. */
  queue(queue: string, queued: number, active: number, deadLettered: number, oldestAgeSeconds?: number): void;
  gauge(name: GaugeName, value: number, labels?: Labels): void;
  render(): string;
}

export type GaugeName =
  | "backup_last_success_timestamp_seconds"
  | "backup_last_size_bytes"
  | "backup_offsite_last_success_timestamp_seconds"
  | "restore_drill_last_success_timestamp_seconds"
  | "disk_used_ratio"
  | "sessions_active"
  | "storage_bytes"
  | "speech_model_state"
  | "worker_heartbeat_age_seconds";

export class NoopMetrics implements Metrics {
  modelCall(): void {}
  turn(): void {}
  voiceFirstWord(): void {}
  voiceFirstPartial(): void {}
  voiceEvent(): void {}
  budgetBlocked(): void {}
  job(): void {}
  http(): void {}
  circuit(): void {}
  alert(): void {}
  queue(): void {}
  gauge(): void {}
  render(): string {
    return "";
  }
}

const GAUGES: Record<GaugeName, { help: string; labels: readonly string[] }> = {
  backup_last_success_timestamp_seconds: {
    help: "Unix time of the last successful backup",
    labels: [],
  },
  backup_last_size_bytes: { help: "Size of the last backup dump", labels: [] },
  backup_offsite_last_success_timestamp_seconds: {
    help: "Unix time of the last successful offsite copy",
    labels: [],
  },
  restore_drill_last_success_timestamp_seconds: {
    help: "Unix time of the last restore drill that matched its manifest",
    labels: [],
  },
  disk_used_ratio: { help: "Fraction of the monitored volume in use", labels: ["mount"] },
  sessions_active: { help: "Sessions with activity in the last five minutes", labels: ["tenant"] },
  storage_bytes: { help: "Bytes of attachments stored", labels: ["tenant"] },
  speech_model_state: {
    help: "On-server speech model: 0 absent, 1 loading, 2 ready, 3 failed",
    labels: [],
  },
  worker_heartbeat_age_seconds: { help: "Age of the worker's liveness file", labels: [] },
};

/** The production implementation: every series the operations plan names, on one registry. */
export class PromMetrics implements Metrics {
  readonly registry = new Registry();
  private readonly firstToken = this.registry.histogram(
    "aidp_turn_first_token_seconds",
    "Time from request to the first streamed token of a model call",
    ["purpose", "provider", "model", "tenant"],
    TURN_BUCKETS,
  );
  private readonly turnDuration = this.registry.histogram(
    "aidp_turn_duration_seconds",
    "Duration of a participant turn",
    ["tenant", "mode"],
    DURATION_BUCKETS,
  );
  private readonly callDuration = this.registry.histogram(
    "aidp_model_call_duration_seconds",
    "Duration of a model call",
    ["purpose", "provider", "model", "status"],
    DURATION_BUCKETS,
  );
  private readonly tokens = this.registry.counter("aidp_model_tokens_total", "Tokens used by model calls", [
    "kind",
    "purpose",
    "provider",
    "tenant",
  ]);
  private readonly cost = this.registry.counter(
    "aidp_model_cost_cents_total",
    "Cost of model calls in cents",
    ["purpose", "provider", "tenant"],
  );
  private readonly audio = this.registry.counter(
    "aidp_voice_audio_seconds_total",
    "Seconds of audio sent to transcription",
    ["tenant"],
  );
  private readonly providerErrors = this.registry.counter(
    "aidp_provider_errors_total",
    "Failed model calls",
    ["provider", "code"],
  );
  private readonly blocked = this.registry.counter(
    "aidp_budget_blocked_total",
    "Calls refused because a budget was used up",
    ["scope", "tenant"],
  );
  private readonly voiceFirstWordH = this.registry.histogram(
    "aidp_voice_first_word_seconds",
    "Question asked to first audible word, live voice",
    ["tenant", "mode"],
    VOICE_BUCKETS,
  );
  private readonly voiceFirstPartialH = this.registry.histogram(
    "aidp_voice_first_partial_seconds",
    "Speech started to first caption, live voice with streaming captions",
    ["tenant", "mode"],
    VOICE_BUCKETS,
  );
  private readonly voiceEvents = this.registry.counter(
    "aidp_voice_events_total",
    "Live voice interruptions and stream fallbacks",
    ["tenant", "event"],
  );
  private readonly jobDuration = this.registry.histogram(
    "aidp_job_duration_seconds",
    "Duration of a job attempt",
    ["name", "outcome"],
    DURATION_BUCKETS,
  );
  private readonly jobFailures = this.registry.counter(
    "aidp_job_failures_total",
    "Failed job attempts; final=true when the job was dead-lettered",
    ["name", "final"],
  );
  private readonly httpDuration = this.registry.histogram(
    "aidp_http_request_duration_seconds",
    "HTTP request duration by route pattern",
    ["route", "method", "status"],
    DURATION_BUCKETS,
  );
  private readonly jobsQueued = this.registry.gauge("aidp_jobs_queued", "Jobs waiting in a queue", ["queue"]);
  private readonly jobsActive = this.registry.gauge("aidp_jobs_active", "Jobs running", ["queue"]);
  private readonly jobsDead = this.registry.gauge(
    "aidp_jobs_dead_lettered",
    "Jobs in the dead-letter queue",
    ["queue"],
  );
  private readonly jobsOldest = this.registry.gauge(
    "aidp_jobs_oldest_queued_age_seconds",
    "Age of the oldest job still waiting in a queue",
    ["queue"],
  );
  private readonly rss = this.registry.gauge(
    "aidp_process_resident_memory_bytes",
    "Resident set size of this process",
  );
  private readonly uptime = this.registry.gauge(
    "aidp_process_uptime_seconds",
    "Seconds since this process started",
  );
  private readonly heapUsed = this.registry.gauge("aidp_process_heap_used_bytes", "V8 heap in use");
  private readonly circuitState = this.registry.gauge(
    "aidp_provider_circuit_state",
    "Provider circuit: 0 closed, 1 half open, 2 open",
    ["provider"],
  );
  private readonly alertsSent = this.registry.counter("aidp_alerts_total", "Alerts by outcome", [
    "kind",
    "severity",
    "outcome",
  ]);
  private readonly named = new Map<GaugeName, Gauge>();

  constructor() {
    for (const [name, def] of Object.entries(GAUGES) as [GaugeName, (typeof GAUGES)[GaugeName]][])
      this.named.set(name, this.registry.gauge(`aidp_${name}`, def.help, def.labels));
  }

  modelCall(c: Parameters<Metrics["modelCall"]>[0]): void {
    const base = { purpose: c.purpose, provider: c.provider, tenant: c.tenant };
    this.callDuration.observe(
      { purpose: c.purpose, provider: c.provider, model: c.model, status: c.status },
      c.latencyMs / 1000,
    );
    if (c.firstTokenMs !== undefined)
      this.firstToken.observe({ ...base, model: c.model }, c.firstTokenMs / 1000);
    this.tokens.inc({ ...base, kind: "input" }, c.inputTokens);
    this.tokens.inc({ ...base, kind: "cache_read" }, c.cacheReadTokens);
    this.tokens.inc({ ...base, kind: "output" }, c.outputTokens);
    this.cost.inc(base, c.costCents);
    if (c.audioSeconds) this.audio.inc({ tenant: c.tenant }, c.audioSeconds);
    if (c.status === "error") this.providerErrors.inc({ provider: c.provider, code: c.errorCode ?? "error" });
  }
  turn(tenant: string, mode: string, durationMs: number): void {
    this.turnDuration.observe({ tenant, mode }, durationMs / 1000);
  }
  voiceFirstWord(tenant: string, mode: string, ms: number): void {
    this.voiceFirstWordH.observe({ tenant, mode }, ms / 1000);
  }
  voiceFirstPartial(tenant: string, mode: string, ms: number): void {
    this.voiceFirstPartialH.observe({ tenant, mode }, ms / 1000);
  }
  voiceEvent(tenant: string, event: "interruption" | "stream_fallback"): void {
    this.voiceEvents.inc({ tenant, event });
  }
  budgetBlocked(tenant: string, scope: string): void {
    this.blocked.inc({ tenant, scope });
  }
  job(name: string, outcome: "ok" | "error", durationMs: number, final = false): void {
    this.jobDuration.observe({ name, outcome }, durationMs / 1000);
    if (outcome === "error") this.jobFailures.inc({ name, final: String(final) });
  }
  http(route: string, method: string, status: number, durationMs: number): void {
    this.httpDuration.observe({ route, method, status: String(status) }, durationMs / 1000);
  }
  circuit(provider: string, state: "closed" | "open" | "half_open"): void {
    this.circuitState.set({ provider }, state === "closed" ? 0 : state === "half_open" ? 1 : 2);
  }
  alert(kind: string, severity: string, outcome: "sent" | "suppressed"): void {
    this.alertsSent.inc({ kind, severity, outcome });
  }
  queue(queue: string, queued: number, active: number, deadLettered: number, oldestAgeSeconds = 0): void {
    this.jobsQueued.set({ queue }, queued);
    this.jobsActive.set({ queue }, active);
    this.jobsDead.set({ queue }, deadLettered);
    this.jobsOldest.set({ queue }, oldestAgeSeconds);
  }
  gauge(name: GaugeName, value: number, labels: Labels = {}): void {
    this.named.get(name)?.set(labels, value);
  }
  private readonly hooks: (() => void)[] = [];

  /** Runs `fn` just before each render: for readings that are cheaper to take when scraped than on a timer. */
  beforeRender(fn: () => void): void {
    this.hooks.push(fn);
  }

  render(): string {
    for (const hook of this.hooks) {
      try {
        hook();
      } catch {
        // A reading that cannot be taken is a missing series, not a failed scrape.
      }
    }
    // Process numbers are read when scraped, so they are never stale and need no timer.
    const mem = process.memoryUsage();
    this.rss.set({}, mem.rss);
    this.heapUsed.set({}, mem.heapUsed);
    this.uptime.set({}, Math.round(process.uptime()));
    return this.registry.render();
  }
}

/**
 * Pure helpers: no network, no filesystem, no process state. These are the only parts of the
 * harness with unit tests (the rest talks to a model and costs money).
 */

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Incremental server-sent-events parser: feed chunks, get whole events back. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const out: SseEvent[] = [];
    let at = this.buffer.indexOf("\n\n");
    while (at >= 0) {
      const block = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 2);
      const parsed = parseBlock(block);
      if (parsed) out.push(parsed);
      at = this.buffer.indexOf("\n\n");
    }
    return out;
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  const raw = data.join("\n");
  try {
    return { event, data: JSON.parse(raw) as unknown };
  } catch {
    return { event, data: raw };
  }
}

/** Nearest-rank percentile; `p` in 0..100. Empty input gives NaN so a missing metric is visible. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? Number.NaN;
}

export function summarize(values: number[]): {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
} {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : Number.NaN,
  };
}

// ---------------------------------------------------------------------------------------------
// Interviewer-message heuristics
// ---------------------------------------------------------------------------------------------

export interface MessageFlags {
  /** More than one question mark: the participant is asked two things at once. */
  multiQuestion: boolean;
  /** Offers or hints at a solution, which the interview must not do. */
  suggestsSolution: boolean;
  /** Asks the participant where AI should be used, which the template forbids. */
  asksWhereAiGoes: boolean;
  /** Phrased to extract agreement rather than information. */
  leading: boolean;
  /** Longer than the template's limit. */
  overLength: boolean;
}

const SOLUTION_PATTERNS: RegExp[] = [
  /\byou (could|should|might want to|may want to) (try|use|build|automate|consider|get|set up|ask|switch|look into)\b/i,
  /\b(have you|did you) (ever )?(considered|tried|thought about)\b/i,
  /\b(we|I) (could|can|would) (build|automate|create|set up|suggest|recommend)\b/i,
  /\bI (suggest|recommend)\b/i,
  /\b(an?|the) (ai|chatbot|bot|automation|tool|dashboard|integration) (could|can|would|might)\b/i,
  /\bwould (it|that) (help|be (great|useful|helpful|nice))\b/i,
  /\bone (solution|option|approach) (is|would be)\b/i,
];

const AI_WHERE_PATTERNS: RegExp[] = [
  /\bwhere (do you|would you|could|should|might)\b[^.?!]*\b(ai|artificial intelligence|automation)\b/i,
  /\bhow (could|would|should|might)\b[^.?!]*\b(ai|artificial intelligence)\b[^.?!]*\b(help|used?|improve)\b/i,
  /\bwhat (would|could) (you|ai)\b[^.?!]*\b(ai|automate)\b/i,
  /\bwhich (tasks?|parts?)\b[^.?!]*\b(ai|automat)/i,
];

const LEADING_PATTERNS: RegExp[] = [
  /\b(don't|doesn't|wouldn't|isn't|aren't|shouldn't) (you|it|that|this)\b[^?]*\?/i,
  /\b(surely|obviously|clearly)\b/i,
  /\bwouldn't it be\b/i,
  /\b(that must be|that sounds) (so |really |very )?(frustrating|painful|annoying|exhausting|tedious)\b/i,
  /,\s*(right|correct|isn't it|don't you think)\?/i,
];

export function flagMessage(text: string, maxChars: number): MessageFlags {
  const questionMarks = (text.match(/\?/g) ?? []).length;
  return {
    multiQuestion: questionMarks > 1,
    suggestsSolution: SOLUTION_PATTERNS.some((p) => p.test(text)),
    asksWhereAiGoes: AI_WHERE_PATTERNS.some((p) => p.test(text)),
    leading: LEADING_PATTERNS.some((p) => p.test(text)),
    overLength: text.length > maxChars,
  };
}

export interface FlagTotals {
  messages: number;
  multiQuestion: number;
  suggestsSolution: number;
  asksWhereAiGoes: number;
  leading: number;
  overLength: number;
}

export function totalFlags(texts: string[], maxChars: number): FlagTotals {
  const totals: FlagTotals = {
    messages: texts.length,
    multiQuestion: 0,
    suggestsSolution: 0,
    asksWhereAiGoes: 0,
    leading: 0,
    overLength: 0,
  };
  for (const t of texts) {
    const f = flagMessage(t, maxChars);
    if (f.multiQuestion) totals.multiQuestion += 1;
    if (f.suggestsSolution) totals.suggestsSolution += 1;
    if (f.asksWhereAiGoes) totals.asksWhereAiGoes += 1;
    if (f.leading) totals.leading += 1;
    if (f.overLength) totals.overLength += 1;
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------------------------

export interface ListedModel {
  id: string;
  contextLength: number;
  /** USD per million tokens. */
  inputPerMtok: number;
  outputPerMtok: number;
  maxCompletionTokens: number | null;
  supportsStructured: boolean;
  textOnly: boolean;
}

export interface ModelNeed {
  /** Tried in order; the first listed one that satisfies the limits wins. */
  prefer: string[];
  minContext: number;
  /** Ceiling on input price per million tokens, so a typo cannot select an expensive model. */
  maxInputPerMtok: number;
  maxOutputPerMtok: number;
}

/** First preferred model that exists and fits; otherwise the cheapest structured-output model that fits. */
export function pickModel(models: ListedModel[], need: ModelNeed): ListedModel | null {
  const fits = (m: ListedModel): boolean =>
    m.textOnly &&
    m.contextLength >= need.minContext &&
    m.inputPerMtok > 0 &&
    m.inputPerMtok <= need.maxInputPerMtok &&
    m.outputPerMtok <= need.maxOutputPerMtok &&
    !m.id.includes(":batch") &&
    !m.id.includes(":free") &&
    !m.id.startsWith("~");
  for (const id of need.prefer) {
    const m = models.find((x) => x.id === id);
    if (m && fits(m)) return m;
  }
  const rest = models
    .filter((m) => fits(m) && m.supportsStructured)
    .sort((a, b) => a.inputPerMtok + 3 * a.outputPerMtok - (b.inputPerMtok + 3 * b.outputPerMtok));
  return rest[0] ?? null;
}

/** Cents for a call at the given per-million prices. */
export function costCents(inTokens: number, outTokens: number, inPerM: number, outPerM: number): number {
  return ((inTokens * inPerM + outTokens * outPerM) / 1_000_000) * 100;
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

/** Replaces every known secret value, and anything shaped like a provider key, with a marker. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted]");
  return out.replace(/\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{24,})/g, "[redacted]");
}

/** Parses a dotenv file: `KEY=value`, optional quotes, `#` comment lines. No expansion. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Report checks
// ---------------------------------------------------------------------------------------------

/** Words of a quote that must all appear, in order, for it to count as present in a text. */
function normalized(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function containsQuote(haystack: string, quote: string): boolean {
  const q = normalized(quote);
  return q.length >= 20 && normalized(haystack).includes(q);
}

/** Extracts the first JSON object in a model reply, tolerating prose and code fences around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

// ---- run isolation ----------------------------------------------------------------------------

export interface RunConfig {
  /** `default` for the historical fixed names, otherwise the sanitised LIVE_RUN_ID. */
  runId: string;
  dbName: string;
  apiPort: number;
  scratchDir: string;
  /** Subdirectory of out/ ("" for the default run). */
  outSubdir: string;
}

const RUN_ID = /^[a-z0-9][a-z0-9_]{0,23}$/;

/** A stable port in 4101..4199 for a run id, so two ids rarely collide and a rerun is predictable. */
export function portForRunId(runId: string): number {
  let h = 0;
  for (const ch of runId) h = (h * 31 + ch.charCodeAt(0)) % 99;
  return 4101 + h;
}

/**
 * Derives the database name, API port, scratch directory and output folder of one run. With no
 * LIVE_RUN_ID the historical names are kept (and the run lock stops a second run). With one, every
 * name carries the id, so concurrent runs cannot drop each other's database. The individual
 * LIVE_DB_NAME, LIVE_API_PORT and LIVE_RUN_SCRATCH still win when set.
 */
export function resolveRunConfig(env: Record<string, string | undefined>, tmp: string): RunConfig {
  const raw = env.LIVE_RUN_ID?.trim().toLowerCase();
  if (raw !== undefined && raw !== "" && !RUN_ID.test(raw)) {
    throw new Error(`LIVE_RUN_ID must match ${RUN_ID} (lowercase letters, digits, underscore; max 24)`);
  }
  const runId = raw === undefined || raw === "" ? "default" : raw;
  const isDefault = runId === "default";
  const sep = tmp.endsWith("/") ? "" : "/";
  return {
    runId,
    dbName: env.LIVE_DB_NAME ?? (isDefault ? "ai_discovery_live" : `ai_discovery_live_${runId}`),
    apiPort: Number(env.LIVE_API_PORT ?? (isDefault ? 4100 : portForRunId(runId))),
    scratchDir: env.LIVE_RUN_SCRATCH ?? `${tmp}${sep}ai-discovery-live${isDefault ? "" : `-${runId}`}`,
    outSubdir: isDefault ? "" : runId,
  };
}

/** Decides whether an existing lock file's content names a live process. Pure for testing. */
export function lockIsHeld(content: string, isAlive: (pid: number) => boolean): boolean {
  const pid = Number(content.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 && isAlive(pid);
}

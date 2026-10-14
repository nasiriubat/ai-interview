/**
 * What the fake provider does, all of it adjustable at run time through `POST /__control`.
 *
 * Defaults come from the environment (FAKE_*), so a compose file can pick a latency profile and a
 * test can change it without restarting anything. Every number is a plain value: the point of the
 * fake is that a load or chaos run can say "the provider takes 400 ms" and mean it, so what the
 * run measures is the platform's own overhead.
 */
export interface Behaviour {
  /** Time to the first byte of any response, before jitter. */
  latencyMs: number;
  jitterMs: number;
  /** Extra wait before the first content token of a streamed chat, on top of `latencyMs`. */
  firstTokenMs: number;
  /** Streaming speed. 0 sends the whole reply at once. */
  charsPerSecond: number;
  /** Probability that a request is answered with `errorStatus`. */
  errorRate: number;
  errorStatus: number;
  /** Probability that a request is answered 429 with a Retry-After of 0 s. */
  rate429: number;
  /** Probability that a request is accepted and then never answered (until the client gives up). */
  hangRate: number;
  /** How long a hung request is held before the connection is dropped. 0 holds it until the client leaves. */
  hangMs: number;
  /** Probability that a streamed chat dies mid-stream, after the first tokens. */
  cutRate: number;
  /** What `/audio/transcriptions` and the realtime socket say the participant said. */
  transcript: string;
  /** Audio the realtime socket must receive before it declares one utterance finished. */
  sttUtteranceMs: number;
  /** Time to the first audio byte of `/audio/speech`. */
  ttsFirstByteMs: number;
  /** Total bytes of synthesized audio. */
  ttsBytes: number;
  /** `unsupported` answers 404 like OpenRouter does; `ok` returns deterministic vectors. */
  embeddings: "unsupported" | "ok";
  /** How `/v1/realtime` behaves: `refuse` answers the session update with an error, `drop` closes on audio. */
  realtime: "ok" | "refuse" | "drop";
  /** Seed of the pseudo-random choices, so a run is repeatable. */
  seed: number;
}

export const NUMERIC_KEYS = [
  "latencyMs",
  "jitterMs",
  "firstTokenMs",
  "charsPerSecond",
  "errorRate",
  "errorStatus",
  "rate429",
  "hangRate",
  "hangMs",
  "cutRate",
  "sttUtteranceMs",
  "ttsFirstByteMs",
  "ttsBytes",
  "seed",
] as const satisfies readonly (keyof Behaviour)[];

const num = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

export function behaviourFromEnv(env: NodeJS.ProcessEnv): Behaviour {
  const realtime = env.FAKE_REALTIME;
  return {
    latencyMs: num(env, "FAKE_LATENCY_MS", 400),
    jitterMs: num(env, "FAKE_JITTER_MS", 100),
    firstTokenMs: num(env, "FAKE_FIRST_TOKEN_MS", 0),
    charsPerSecond: num(env, "FAKE_CHARS_PER_S", 400),
    errorRate: num(env, "FAKE_ERROR_RATE", 0),
    errorStatus: num(env, "FAKE_ERROR_STATUS", 500),
    rate429: num(env, "FAKE_RATE_429", 0),
    hangRate: num(env, "FAKE_HANG_RATE", 0),
    hangMs: num(env, "FAKE_HANG_MS", 0),
    cutRate: num(env, "FAKE_CUT_RATE", 0),
    transcript: env.FAKE_TRANSCRIPT ?? "We print the order and type it in again by hand.",
    sttUtteranceMs: num(env, "FAKE_STT_UTTERANCE_MS", 1000),
    ttsFirstByteMs: num(env, "FAKE_TTS_FIRST_BYTE_MS", 250),
    ttsBytes: num(env, "FAKE_TTS_BYTES", 24_000),
    embeddings: env.FAKE_EMBEDDINGS === "ok" ? "ok" : "unsupported",
    realtime: realtime === "refuse" || realtime === "drop" ? realtime : "ok",
    seed: num(env, "FAKE_SEED", 1),
  };
}

/** Applies a control request's body, ignoring unknown keys and values of the wrong type. */
export function applyControl(current: Behaviour, patch: unknown): Behaviour {
  if (!patch || typeof patch !== "object") return current;
  const p = patch as Record<string, unknown>;
  const next: Behaviour = { ...current };
  for (const key of NUMERIC_KEYS) {
    const v = p[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) next[key] = v;
  }
  if (typeof p.transcript === "string") next.transcript = p.transcript;
  if (p.embeddings === "ok" || p.embeddings === "unsupported") next.embeddings = p.embeddings;
  if (p.realtime === "ok" || p.realtime === "refuse" || p.realtime === "drop") next.realtime = p.realtime;
  return next;
}

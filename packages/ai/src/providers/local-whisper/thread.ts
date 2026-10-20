import { parentPort, workerData } from "node:worker_threads";
import type { LanguageHint } from "./runner.js";
import type { ThreadReply, ThreadRequest } from "./thread-engine.js";

/**
 * The speech thread: the only code that loads transformers.js and the ONNX runtime (D-75).
 *
 * It is imported dynamically, here and nowhere else, so that importing `@aidp/ai` — in tests, the
 * worker, a seed script — never pulls in a native runtime or its 45 MB shared library. The thread
 * holds one model at a time and handles one message at a time; the runner on the other side of
 * the port already serializes requests, so there is no queue here.
 */

/** The slice of transformers.js this file touches, typed locally to keep its types out of the build. */
interface Transformers {
  env: { cacheDir: string | null; allowLocalModels: boolean };
  pipeline(
    task: "automatic-speech-recognition",
    model: string,
    options: {
      dtype: string;
      device: "cpu";
      progress_callback: (p: ProgressInfo) => void;
      session_options?: { intraOpNumThreads: number; interOpNumThreads: number };
    },
  ): Promise<AsrPipeline>;
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
}

interface ProgressInfo {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

interface AsrPipeline {
  (audio: Float32Array, options: Record<string, unknown>): Promise<{ text: string } | { text: string }[]>;
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>;
  model: ((inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number> } }>) & {
    generation_config: { decoder_start_token_id: number; lang_to_id?: Record<string, number> };
  };
  dispose(): Promise<void>;
}

const { cacheDir, threads } = workerData as { cacheDir: string; threads?: number };
const port = parentPort;
if (!port) throw new Error("thread.ts must run as a worker thread");

let tf: Transformers | undefined;
let current: { model: string; dtype: string; asr: AsrPipeline } | undefined;

async function transformers(): Promise<Transformers> {
  if (tf) return tf;
  const mod = (await import("@huggingface/transformers")) as Transformers;
  mod.env.cacheDir = cacheDir;
  // Only the cache and the Hugging Face hub: never a path relative to wherever the package sits.
  mod.env.allowLocalModels = false;
  tf = mod;
  return mod;
}

async function load(id: number, model: string, dtype: string): Promise<AsrPipeline> {
  if (current?.model === model && current.dtype === dtype) return current.asr;
  const lib = await transformers();
  if (current) {
    const old = current.asr;
    current = undefined;
    await old.dispose().catch(() => undefined);
  }
  // Progress across every file of the model, not per file, so the operator sees one number climb.
  const files = new Map<string, { loaded: number; total: number }>();
  let lastSent = -1;
  const asr = await lib.pipeline("automatic-speech-recognition", model, {
    dtype,
    device: "cpu",
    // ONNX otherwise starts a thread per host core. In a container allowed 1.5 of 8 cores those
    // threads spend most of their time throttled: a 4-second answer took 28 seconds (2026-10-20).
    ...(threads ? { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } : {}),
    progress_callback: (p) => {
      if (p.status !== "progress" || !p.file || !p.total) return;
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      const fraction = total > 0 ? Math.min(1, loaded / total) : undefined;
      // Two decimal places is plenty; a message per network chunk is not.
      const rounded = fraction === undefined ? -1 : Math.floor(fraction * 100);
      if (rounded === lastSent) return;
      lastSent = rounded;
      reply({ type: "progress", id, fraction });
    },
  });
  current = { model, dtype, asr };
  return asr;
}

/**
 * Whisper's own language identification: one decoder step after the start token, read off the
 * language tokens. transformers.js does not do this itself — without a language it silently
 * assumes English, and Whisper then *translates* a Finnish answer into English, which would put
 * words in the participant's mouth. It costs one extra encoder pass, about half a second.
 */
async function detectLanguage(
  asr: AsrPipeline,
  audio: Float32Array,
  candidates: string[] | undefined,
): Promise<string | undefined> {
  const lib = await transformers();
  const config = asr.model.generation_config;
  const languages = config.lang_to_id;
  if (!languages) return undefined; // an English-only model
  const { input_features } = await asr.processor(audio.subarray(0, 30 * 16_000));
  const out = await asr.model({
    input_features,
    decoder_input_ids: new lib.Tensor(
      "int64",
      BigInt64Array.from([BigInt(config.decoder_start_token_id)]),
      [1, 1],
    ),
  });
  let best: string | undefined;
  let bestLogit = Number.NEGATIVE_INFINITY;
  const allowed = candidates?.length ? new Set(candidates.map((c) => `<|${c}|>`)) : undefined;
  for (const [token, tokenId] of Object.entries(languages)) {
    if (allowed && !allowed.has(token)) continue;
    const logit = out.logits.data[tokenId] ?? Number.NEGATIVE_INFINITY;
    if (logit > bestLogit) {
      bestLogit = logit;
      best = token;
    }
  }
  return best?.replace(/^<\|/, "").replace(/\|>$/, "");
}

async function transcribe(id: number, model: string, audio: Float32Array, hint: LanguageHint): Promise<void> {
  if (current?.model !== model) throw new Error(`Model ${model} is not loaded`);
  const asr = current.asr;
  const lang = hint.language ?? (await detectLanguage(asr, audio, hint.candidates));
  const out = await asr(audio, {
    ...(lang ? { language: lang } : {}),
    task: "transcribe",
    // Recordings run to five minutes; Whisper sees 30 seconds at a time.
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
  reply({ type: "result", id, text, ...(lang ? { language: lang } : {}) });
}

function reply(msg: ThreadReply): void {
  port?.postMessage(msg);
}

port.on("message", (msg: ThreadRequest) => {
  const work =
    msg.type === "load"
      ? load(msg.id, msg.model, msg.dtype).then(() => {
          reply({ type: "loaded", id: msg.id });
        })
      : transcribe(msg.id, msg.model, msg.audio, msg.hint);
  work.catch((err: unknown) => {
    reply({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
  });
});

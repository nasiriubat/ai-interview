import { readFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "../types.js";
import { localWhisperModel } from "./models.js";
import { WorkerThreadEngine } from "./thread-engine.js";
import { WHISPER_SAMPLE_RATE } from "./wav.js";

/**
 * The port behind the `local` provider: whatever actually runs Whisper.
 *
 * In production that is a `node:worker_threads` thread holding transformers.js and the ONNX
 * runtime; in tests it is an in-memory fake, so no test ever loads onnxruntime or downloads a model.
 * An engine holds one model at a time: loading another replaces it, because two Whisper models in
 * one API process is the difference between fitting in the VPS's memory and not.
 */
export interface SpeechToTextEngine {
  /** Loads the model, downloading it into the cache first if needed. Resolves when it can run. */
  load(model: string, dtype: string, onProgress: (fraction: number | undefined) => void): Promise<void>;
  /** 16 kHz mono float samples in. */
  transcribe(model: string, audio: Float32Array, hint: LanguageHint): Promise<SpeechResult>;
  /** Kills whatever is running and forgets the loaded model. Used when a transcription overruns. */
  reset(): Promise<void>;
}

/** ISO 639-1 codes. */
export interface LanguageHint {
  /** Transcribe in this language; nothing is detected. */
  language?: string;
  /** Detect the language, choosing among these; all of Whisper's languages when absent. */
  candidates?: string[];
}

export interface SpeechResult {
  text: string;
  /** The language the model transcribed in: the hint when one was given, else what it detected. */
  language?: string;
}

export type SpeechModelState = "not_loaded" | "downloading" | "ready" | "error";

/** Reported by the readiness endpoint, so an operator can see the first download happen. */
export interface SpeechStatus {
  model: string | null;
  state: SpeechModelState;
  /** 0..1 while downloading, when the server says how big the files are. */
  progress?: number;
  error?: string;
  /** Transcriptions waiting behind the one running. */
  queued: number;
}

export interface SpeechRunnerOptions {
  /**
   * How long a request may wait to start: behind other recordings, and behind the first download.
   * Past this the participant is told to try again rather than left watching a spinner; their
   * recording is already stored, and the load carries on for the next attempt.
   */
  startTimeoutMs?: number;
  /** How long one transcription may run once started, given the length of the audio. */
  runTimeoutMs?: (audioSeconds: number) => number;
  /** More than this many waiting and new requests are turned away. */
  maxQueued?: number;
  /**
   * Release the model after this long without a transcription; 0 keeps it loaded forever. Holding
   * whisper-small costs about 700 MB of RAM around the clock, and loading it again from the disk
   * cache takes about a second, so on a single VPS an idle server should not keep it.
   */
  idleUnloadMs?: number;
}

/** What the API, the providers and the readiness check need from on-server speech to text. */
export interface SpeechService {
  status(): SpeechStatus;
  warmUp(model: string, onProgress?: (fraction: number | undefined) => void): Promise<void>;
  transcribe(model: string, audio: Float32Array, hint?: LanguageHint): Promise<SpeechResult>;
}

/**
 * Whisper on the CPU is one heavy job at a time. Running two at once does not finish either sooner
 * — they share the same cores — it only doubles the memory and makes both late, so requests queue.
 */
export class SpeechRunner implements SpeechService {
  private tail: Promise<unknown> = Promise.resolve();
  private current: string | null = null;
  private state: Omit<SpeechStatus, "queued"> = { model: null, state: "not_loaded" };
  private waiting = 0;
  private active = 0;
  private readonly startTimeoutMs: number;
  private readonly runTimeoutMs: (audioSeconds: number) => number;
  private readonly maxQueued: number;
  private readonly idleUnloadMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly engine: SpeechToTextEngine,
    opts: SpeechRunnerOptions = {},
  ) {
    this.startTimeoutMs = opts.startTimeoutMs ?? 120_000;
    // A minute of headroom plus real time: whisper-small at q8 runs several times faster than real
    // time on a 2-vCPU VPS, so a transcription that needs longer than the audio itself is stuck.
    this.runTimeoutMs = opts.runTimeoutMs ?? ((seconds) => 60_000 + seconds * 1000);
    this.maxQueued = opts.maxQueued ?? 20;
    this.idleUnloadMs = opts.idleUnloadMs ?? 10 * 60_000;
  }

  status(): SpeechStatus {
    return { ...this.state, queued: this.waiting };
  }

  /** Recordings this runner holds: waiting, and the one running. What a pool balances on. */
  load(): number {
    return this.waiting + this.active;
  }

  /**
   * Loads the model ahead of the first recording, so that participant does not wait for a 250 MB
   * download. Never throws: a server that is offline at boot still starts, and says why in
   * `status()`; the next transcription tries the load again.
   */
  async warmUp(model: string, onProgress?: (fraction: number | undefined) => void): Promise<void> {
    await this.exclusive(() => this.ensureLoaded(model, onProgress)).catch(() => undefined);
    this.scheduleUnload();
  }

  async transcribe(model: string, audio: Float32Array, hint: LanguageHint = {}): Promise<SpeechResult> {
    if (this.waiting >= this.maxQueued)
      throw new ProviderError("Too many recordings are waiting to be transcribed", "rate_limit", true);
    this.waiting++;
    this.cancelUnload();
    let left = false;
    const leaveQueue = (): void => {
      if (left) return;
      left = true;
      this.waiting--;
    };
    const request = { abandoned: false };
    let markStarted = (): void => undefined;
    const started = new Promise<"started">((resolve) => {
      markStarted = () => {
        resolve("started");
      };
    });
    const work = this.exclusive(async () => {
      if (request.abandoned) return undefined;
      await this.ensureLoaded(model);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the start timeout sets it while the load is awaited
      if (request.abandoned) return undefined;
      leaveQueue();
      markStarted();
      this.active++;
      try {
        return await this.run(model, audio, hint);
      } finally {
        this.active--;
      }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, this.startTimeoutMs);
    });
    const settled = work.then(
      () => "settled" as const,
      () => "settled" as const,
    );
    const first = await Promise.race([started, settled, timedOut]);
    clearTimeout(timer);
    if (first === "timeout") {
      request.abandoned = true;
      leaveQueue();
      const loading = this.state.state === "downloading" && this.state.model === model;
      throw new ProviderError(
        loading
          ? "The speech model is still downloading to the server; try again in a minute"
          : "The server is busy transcribing other recordings; try again in a minute",
        "server",
        true,
      );
    }
    try {
      const result = await work;
      if (!result) throw new ProviderError("Transcription was abandoned", "server", true);
      return result;
    } finally {
      leaveQueue(); // it may have failed before it started, e.g. when the load failed
      this.scheduleUnload();
    }
  }

  private cancelUnload(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** (Re)starts the idle clock; when it runs out with nothing queued, the model is let go. */
  private scheduleUnload(): void {
    this.cancelUnload();
    if (this.idleUnloadMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      void this.exclusive(async () => {
        // Something arrived while this waited its turn: it needs the model, keep it.
        if (this.waiting > 0 || this.current === null) return;
        await this.engine.reset();
        this.current = null;
        this.state = { model: null, state: "not_loaded" };
      }).catch(() => undefined);
    }, this.idleUnloadMs);
    // An idle clock must never be the reason a process (or a test run) stays alive.
    this.idleTimer.unref();
  }

  /** Serializes everything that touches the engine. A failure does not break the chain. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async ensureLoaded(
    model: string,
    onProgress?: (fraction: number | undefined) => void,
  ): Promise<void> {
    if (this.current === model) return;
    const spec = localWhisperModel(model);
    if (!spec) throw new ProviderError(`'${model}' is not a model this server runs`, "bad_request", false);
    this.current = null;
    this.state = { model, state: "downloading" };
    try {
      await this.engine.load(model, spec.dtype, (fraction) => {
        this.state = {
          model,
          state: "downloading",
          ...(fraction === undefined ? {} : { progress: fraction }),
        };
        onProgress?.(fraction);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = { model, state: "error", error: message.slice(0, 300) };
      throw new ProviderError(`Could not load the speech model ${model}: ${message}`, "network", true, err);
    }
    this.current = model;
    this.state = { model, state: "ready" };
  }

  private async run(model: string, audio: Float32Array, hint: LanguageHint): Promise<SpeechResult> {
    const limit = this.runTimeoutMs(audio.length / WHISPER_SAMPLE_RATE);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overrun = new Promise<"overrun">((resolve) => {
      timer = setTimeout(() => {
        resolve("overrun");
      }, limit);
    });
    try {
      const result = await Promise.race([this.engine.transcribe(model, audio, hint), overrun]);
      if (result !== "overrun") return result;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        "server",
        true,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
    // The thread is still grinding on it. Kill it so the next recording is not stuck behind a
    // job nobody is waiting for; the model reloads from the disk cache in about a second.
    await this.engine.reset();
    this.current = null;
    this.state = { model: null, state: "not_loaded" };
    throw new ProviderError(
      `Transcription took longer than ${Math.round(limit / 1000)} s and was stopped`,
      "server",
      true,
    );
  }
}

/**
 * `SPEECH_MODEL_IDLE_MINUTES`: how long the model stays in memory after the last recording.
 * Default 10; 0 keeps it loaded forever, for a server that has RAM to spare and wants every
 * answer back without the one-second reload.
 */
export function idleUnloadMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SPEECH_MODEL_IDLE_MINUTES?.trim();
  const minutes = raw ? Number(raw) : 10;
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : 10 * 60_000;
}

/** Where downloaded models live: the `models` volume in the container, a user cache otherwise. */
export function modelCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MODEL_CACHE_DIR?.trim();
  // An empty MODEL_CACHE_DIR (compose's `${VAR:-}`) means unset, not "the current directory".
  return configured !== undefined && configured.length > 0
    ? configured
    : join(homedir(), ".cache", "aidp-models");
}

/**
 * Threads for the ONNX runtime: `SPEECH_MODEL_THREADS`, or the CPUs this container may use (its
 * cgroup quota, rounded up), or the cores Node sees when there is no quota. More threads than the
 * CPUs a container may use only queue, throttled, for the same slice of time.
 */
export function speechThreads(
  env: NodeJS.ProcessEnv = process.env,
  cpuMax: () => string = readCpuMax,
): number {
  const configured = Number(env.SPEECH_MODEL_THREADS?.trim());
  if (Number.isInteger(configured) && configured > 0) return configured;
  const [quota, period] = cpuMax().trim().split(/\s+/);
  const allowed = Number(quota) / Number(period);
  return Number.isFinite(allowed) && allowed > 0
    ? Math.max(1, Math.ceil(allowed))
    : Math.max(1, availableParallelism());
}

/** cgroup v2's `cpu.max`: "<quota> <period>", or "max <period>" without a limit. */
function readCpuMax(): string {
  try {
    return readFileSync("/sys/fs/cgroup/cpu.max", "utf8");
  } catch {
    return "max";
  }
}

/**
 * Several runners side by side (D-494), each with its own engine, model copy and share of the CPU,
 * and each recording sent to the one with the least waiting. One engine given every core does not
 * scale with them: measured on whisper-small, two engines with two threads each finish four
 * recordings about a quarter sooner than one engine with four, and a short answer no longer waits
 * behind a long one. Each runner keeps its own queue, timeouts and idle unloading.
 */
export class SpeechPool implements SpeechService {
  constructor(private readonly runners: readonly SpeechRunner[]) {
    if (runners.length === 0) throw new Error("SpeechPool needs at least one runner");
  }

  status(): SpeechStatus {
    const all = this.runners.map((r) => r.status());
    // The pool is as ready as its best runner, and everything waiting anywhere is waiting.
    const best =
      all.find((s) => s.state === "ready") ??
      all.find((s) => s.state === "downloading") ??
      all.find((s) => s.state === "error") ??
      all[0];
    if (!best) return { model: null, state: "not_loaded", queued: 0 };
    return { ...best, queued: all.reduce((n, s) => n + s.queued, 0) };
  }

  async warmUp(model: string, onProgress?: (fraction: number | undefined) => void): Promise<void> {
    // The first downloads the model and reports it; the rest then load it from the disk cache.
    const [first, ...rest] = this.runners;
    await first?.warmUp(model, onProgress);
    await Promise.all(rest.map((r) => r.warmUp(model)));
  }

  transcribe(model: string, audio: Float32Array, hint: LanguageHint = {}): Promise<SpeechResult> {
    const target = this.runners.reduce((a, b) => (b.load() < a.load() ? b : a));
    return target.transcribe(model, audio, hint);
  }
}

/** `SPEECH_WORKERS`: how many engines transcribe side by side. Default 1. */
export function speechWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SPEECH_WORKERS?.trim());
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 1;
}

let shared: SpeechService | undefined;

/**
 * The process-wide speech service: `SPEECH_WORKERS` engines, each with its share of the threads
 * (`speechThreads` divided between them, at least one, unless SPEECH_MODEL_THREADS sets it per
 * engine), however many providers and tenants route to it. Created on first use, so a process that
 * never transcribes never starts a thread.
 */
export function localSpeechRunner(): SpeechService {
  if (!shared) {
    const workers = speechWorkers();
    const explicit = Number(process.env.SPEECH_MODEL_THREADS?.trim());
    const threads =
      Number.isInteger(explicit) && explicit > 0
        ? explicit
        : Math.max(1, Math.floor(speechThreads() / workers));
    const runners = Array.from(
      { length: workers },
      () =>
        new SpeechRunner(new WorkerThreadEngine({ cacheDir: modelCacheDir(), threads }), {
          idleUnloadMs: idleUnloadMs(),
        }),
    );
    const [only] = runners;
    shared = runners.length === 1 && only ? only : new SpeechPool(runners);
  }
  return shared;
}

/** The runner's status without creating it: `not_loaded` in a process that has not used it. */
export function localSpeechStatus(): SpeechStatus {
  return shared?.status() ?? { model: null, state: "not_loaded", queued: 0 };
}

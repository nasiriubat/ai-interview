import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { LanguageHint, SpeechResult, SpeechToTextEngine } from "./runner.js";

/** Messages to the thread. */
export type ThreadRequest =
  | { type: "load"; id: number; model: string; dtype: string }
  | { type: "transcribe"; id: number; model: string; audio: Float32Array; hint: LanguageHint };

/** Messages from the thread. */
export type ThreadReply =
  | { type: "progress"; id: number; fraction: number | undefined }
  | { type: "loaded"; id: number }
  | { type: "result"; id: number; text: string; language?: string }
  | { type: "error"; id: number; message: string };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: (fraction: number | undefined) => void;
}

/**
 * Runs Whisper on a `node:worker_threads` thread, so a transcription that takes seconds of CPU
 * never blocks the API's event loop: other participants' turns keep streaming while it runs.
 *
 * The thread is started on first use and replaced after `reset`. It is unreferenced while idle, so
 * it never keeps a process alive by itself, and referenced while a request is in flight, so a script
 * awaiting a transcription is not cut off halfway through.
 */
export class WorkerThreadEngine implements SpeechToTextEngine {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly opts: { cacheDir: string; threads?: number }) {}

  load(model: string, dtype: string, onProgress: (fraction: number | undefined) => void): Promise<void> {
    const id = ++this.seq;
    return this.call<undefined>({ type: "load", id, model, dtype }, [], onProgress).then(() => undefined);
  }

  transcribe(model: string, audio: Float32Array, hint: LanguageHint): Promise<SpeechResult> {
    const id = ++this.seq;
    // A copy the thread can own: the caller's array may be a view into a larger buffer.
    const copy = audio.slice();
    return this.call<SpeechResult>({ type: "transcribe", id, model, audio: copy, hint }, [copy.buffer]);
  }

  async reset(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error("The speech thread was restarted"));
    if (worker) await worker.terminate();
  }

  private call<T>(
    msg: ThreadRequest,
    transfer: ArrayBuffer[],
    onProgress?: (fraction: number | undefined) => void,
  ): Promise<T> {
    const worker = this.thread();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onProgress ? { onProgress } : {}),
      });
      worker.ref();
      worker.postMessage(msg, transfer);
    });
  }

  private thread(): Worker {
    if (this.worker) return this.worker;
    // Built from a path rather than written as `new Worker(new URL(...))`, which bundlers recognise
    // and would follow into transformers.js; nothing outside the API process should ever load it.
    const file = fileURLToPath(new URL("./thread.js", import.meta.url));
    const worker = new Worker(file, {
      workerData: { cacheDir: this.opts.cacheDir, threads: this.opts.threads },
    });
    worker.unref();
    worker.on("message", (reply: ThreadReply) => {
      this.onReply(reply);
    });
    worker.on("error", (err) => {
      if (this.worker === worker) this.worker = null;
      this.failAll(err);
    });
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = null;
      this.failAll(new Error(`The speech thread exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  private onReply(reply: ThreadReply): void {
    const p = this.pending.get(reply.id);
    if (!p) return;
    if (reply.type === "progress") {
      p.onProgress?.(reply.fraction);
      return;
    }
    this.pending.delete(reply.id);
    if (this.pending.size === 0) this.worker?.unref();
    if (reply.type === "error") p.reject(new Error(reply.message));
    else if (reply.type === "result")
      p.resolve({ text: reply.text, ...(reply.language === undefined ? {} : { language: reply.language }) });
    else p.resolve(undefined);
  }

  private failAll(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }
}

import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { Extracted } from "./extract.js";
import { DEFAULT_INGEST_LIMITS, IngestRejected, type IngestLimits } from "./limits.js";

/**
 * Parsing in a worker thread with a heap ceiling and a deadline (P11, D-160).
 *
 * The parsers read hostile input. A pathological PDF can make pdf.js spin for minutes, and a
 * crafted workbook can balloon the heap; either, in the API or worker process itself, takes the
 * whole process and every other participant's request with it. In a worker thread the same fault
 * is a rejected promise: the thread is terminated at the deadline, or when it crosses
 * `resourceLimits`, and the attachment is marked failed with a reason the participant can read.
 *
 * What this does not bound: `resourceLimits` covers the JavaScript heap, not `ArrayBuffer`
 * memory outside it, and a worker shares the process's address space and file descriptors. The
 * input size cap and the zip and page limits are what bound those. A child process with no
 * network is the stronger step and is recorded as the optional follow-up (plan A9).
 */

export interface WorkerOutcome<T> {
  value: T;
}

export interface RunOptions {
  timeoutMs: number;
  heapMb: number;
  /** Buffers handed over rather than copied. */
  transfer?: ArrayBuffer[];
}

/**
 * Runs `entry` as a worker, hands it `data`, and resolves with the one message it posts back.
 * `entry` must be a plain JavaScript module; it posts `{ ok: true, value }` or `{ ok: false, ... }`.
 */
export function runInWorker<T>(entry: URL, data: unknown, options: RunOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(entry, {
      workerData: data,
      ...(options.transfer ? { transferList: options.transfer } : {}),
      resourceLimits: {
        maxOldGenerationSizeMb: options.heapMb,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 4,
      },
      // The worker reads input and returns text; it has no use for the process's environment.
      env: {},
    });
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      done(() => {
        reject(
          new IngestRejected(
            "timeout",
            "Reading that file took too long, so it was skipped. A smaller or simpler file may work",
          ),
        );
      });
    }, options.timeoutMs);
    timer.unref();

    worker.on("message", (msg: { ok: boolean; value?: T; code?: string; message?: string }) => {
      done(() => {
        if (msg.ok) {
          resolve(msg.value as T);
        } else {
          reject(
            new IngestRejected(
              (msg.code as IngestRejected["code"] | undefined) ?? "worker_failed",
              msg.message ?? "That file could not be read",
            ),
          );
        }
      });
    });
    worker.on("error", (err: Error & { code?: string }) => {
      done(() => {
        if (err.code === "ERR_WORKER_OUT_OF_MEMORY") {
          reject(new IngestRejected("memory", "That file needs more memory to read than is allowed"));
        } else {
          reject(new IngestRejected("worker_failed", "That file could not be read"));
        }
      });
    });
    worker.on("exit", () => {
      done(() => {
        reject(new IngestRejected("worker_failed", "That file could not be read"));
      });
    });
  });
}

/** The compiled worker beside this file, or the built copy when running from TypeScript sources. */
export function extractWorkerEntry(): URL {
  const here = new URL(import.meta.url);
  if (here.pathname.endsWith(".ts")) {
    const built = new URL("../../dist/ingest/extract-worker.js", here);
    if (!existsSync(built)) {
      throw new Error("extract-worker.js is not built; run `pnpm --filter @aidp/ai build` first");
    }
    return built;
  }
  return new URL("./extract-worker.js", here);
}

/** `extractText` in an isolated worker. The bytes are copied once and handed over. */
export async function extractIsolated(
  bytes: Buffer,
  mime: string,
  limits: IngestLimits = DEFAULT_INGEST_LIMITS,
): Promise<Extracted> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return await runInWorker<Extracted>(
    extractWorkerEntry(),
    { bytes: copy, mime, limits },
    { timeoutMs: limits.timeoutMs, heapMb: limits.workerHeapMb, transfer: [copy.buffer] },
  );
}

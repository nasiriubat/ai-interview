import { parentPort, workerData } from "node:worker_threads";
import { extractText } from "./extract.js";
import { IngestRejected, type IngestLimits } from "./limits.js";

/**
 * The worker half of `extractIsolated` (P11). Reads `{ bytes, mime, limits }` from `workerData`,
 * extracts, and posts exactly one message back. Anything that goes wrong is reported as data:
 * the parent never has to parse a stack trace to tell a rejected file from a crash.
 */
const { bytes, mime, limits } = workerData as {
  bytes: Uint8Array;
  mime: string;
  limits: IngestLimits;
};

try {
  const value = await extractText(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    mime,
    limits,
  );
  parentPort?.postMessage({ ok: true, value });
} catch (err) {
  if (err instanceof IngestRejected) {
    parentPort?.postMessage({ ok: false, code: err.code, message: err.message });
  } else {
    parentPort?.postMessage({ ok: false, code: "worker_failed", message: "That file could not be read" });
  }
}

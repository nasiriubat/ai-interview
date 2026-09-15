import { FilesystemStorage } from "./filesystem.js";
import { MemoryStorage } from "./memory.js";
import type { StoragePort } from "./port.js";

export * from "./port.js";
export * from "./memory.js";
export * from "./filesystem.js";

/**
 * Chooses the store from configuration: a directory if one is set, memory otherwise.
 *
 * Memory is the right default for a test and for `pnpm dev` with nothing configured — uploads work,
 * they simply do not outlive the process. It is the wrong default for a server, which is why
 * `deploy/compose.prod.yml` always sets `UPLOAD_DIR` and mounts a volume at it, and why the
 * readiness check reports which store is in force rather than leaving it to be discovered when a
 * participant's recording vanishes on the next deploy.
 */
export function createStorage(uploadDir: string | undefined): StoragePort {
  return uploadDir && uploadDir.length > 0 ? new FilesystemStorage(uploadDir) : new MemoryStorage();
}

/** What the store is, for health output and logs. Never includes the path itself. */
export function storageKind(storage: StoragePort): "filesystem" | "memory" | "other" {
  if (storage instanceof FilesystemStorage) return "filesystem";
  if (storage instanceof MemoryStorage) return "memory";
  return "other";
}

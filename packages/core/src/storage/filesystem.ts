import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertSafeKey,
  ObjectNotFound,
  ObjectTooLarge,
  type PutOptions,
  type StoragePort,
  type StoredObject,
} from "./port.js";

/**
 * Objects as files under one directory, which on a server is a Docker volume.
 *
 * This is the default for a single-host deployment, and the reason is subtraction: object storage
 * would mean another container to run, another credential to rotate, another service to watch and
 * another thing to back up separately. A directory is none of those. It is backed up by the same
 * nightly job as the database (see deploy/backup.sh) and restored by the same script.
 *
 * The trade is that it does not survive the host and does not scale past it. {@link S3Storage} is
 * there for when that stops being true; nothing above this layer changes.
 */
export class FilesystemStorage implements StoragePort {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, body: Buffer | Readable, options: PutOptions): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });

    // Written beside the target and moved into place, so a crash or a failed size check never
    // leaves a half-written object that later reads as a truncated document or clipped audio.
    // Rename within one filesystem is atomic.
    const temp = `${path}.${process.pid}.${Date.now()}.part`;
    let sizeBytes = 0;
    try {
      if (Buffer.isBuffer(body)) {
        if (options.maxBytes !== undefined && body.byteLength > options.maxBytes) {
          throw new ObjectTooLarge(options.maxBytes, body.byteLength);
        }
        await writeFile(temp, body, { mode: 0o640 });
        sizeBytes = body.byteLength;
      } else {
        sizeBytes = await writeStream(body, temp, options.maxBytes);
      }
      await writeFile(`${path}.type`, options.contentType, { mode: 0o640 });
      await rename(temp, path);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return { key, contentType: options.contentType, sizeBytes };
  }

  async get(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    try {
      await stat(path);
    } catch {
      throw new ObjectNotFound(key);
    }
    return createReadStream(path);
  }

  async head(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    try {
      const info = await stat(path);
      return { key, contentType: await this.contentType(path), sizeBytes: info.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.type`, { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    // A prefix is a directory here, because keys are built from path segments (see attachmentKey).
    const path = this.pathFor(prefix.replace(/\/+$/, ""));
    const counted = await countObjects(path);
    await rm(path, { recursive: true, force: true });
    return counted;
  }

  private async contentType(path: string): Promise<string> {
    try {
      return (await readFile(`${path}.type`, "utf8")).trim() || "application/octet-stream";
    } catch {
      return "application/octet-stream";
    }
  }

  /**
   * Resolves a key to a path and proves the result is still inside the root.
   *
   * `assertSafeKey` already rejects anything but `[A-Za-z0-9_-]` per segment, so traversal cannot
   * be expressed in the first place. This is the second check, because the cost of being wrong
   * here is writing attacker-chosen bytes to an attacker-chosen path on the host.
   */
  private pathFor(key: string): string {
    const path = resolve(join(this.root, assertSafeKey(key)));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`Storage key escapes the root: ${key}`);
    }
    return path;
  }
}

async function writeStream(body: Readable, path: string, maxBytes?: number): Promise<number> {
  let total = 0;
  const counter = new Readable({ read: () => undefined });
  body.on("data", (chunk: Buffer) => {
    total += chunk.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      body.destroy(new ObjectTooLarge(maxBytes, total));
      return;
    }
    counter.push(chunk);
  });
  body.on("end", () => counter.push(null));
  body.on("error", (err) => counter.destroy(err));
  await pipeline(counter, createWriteStream(path, { mode: 0o640 }));
  return total;
}

/** Objects, not files: the sidecar that records a content type is not one. */
async function countObjects(path: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) total += await countObjects(join(path, entry.name));
    else if (!entry.name.endsWith(".type") && !entry.name.endsWith(".part")) total++;
  }
  return total;
}

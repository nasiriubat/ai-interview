import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertSafeKey,
  byteLimit,
  type PrefixInfo,
  isOutOfSpace,
  ObjectNotFound,
  ObjectTooLarge,
  StorageFull,
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

    // Written beside the target and moved into place, so a crash or a failed size check never
    // leaves a half-written object that later reads as a truncated document or clipped audio.
    // Rename within one filesystem is atomic.
    const temp = `${path}.${process.pid}.${Date.now()}.part`;
    let sizeBytes = 0;
    try {
      await mkdir(dirname(path), { recursive: true });
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
      // A full disk is not a fault in the request or in the code: say so, typed (D-283).
      throw isOutOfSpace(err) ? new StorageFull() : err;
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

  async listPrefixes(parent: string): Promise<PrefixInfo[]> {
    const trimmed = parent.replace(/\/+$/, "");
    const dir = trimmed === "" ? this.root : this.pathFor(trimmed);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: PrefixInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        out.push({ name: entry.name, modifiedAt: await newestWrite(join(dir, entry.name)) });
      } catch {
        // Removed between the listing and the stat: it is gone, which is what the caller wants.
      }
    }
    return out;
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
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb): void {
      total += chunk.byteLength;
      cb(null, chunk);
    },
  });
  // One pipeline, so backpressure runs from the disk back to the sender and an error anywhere
  // (the limit, the source, the file) tears the whole chain down.
  await pipeline(body, byteLimit(maxBytes), counter, createWriteStream(path, { mode: 0o640 }));
  return total;
}

/** The newest modification time anywhere beneath a directory, the directory itself included. */
async function newestWrite(path: string): Promise<Date> {
  let newest = (await stat(path)).mtime;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const t = entry.isDirectory() ? await newestWrite(child) : (await stat(child)).mtime;
    if (t > newest) newest = t;
  }
  return newest;
}

/** Objects, not files: the sidecar that records a content type is not one. */
async function countObjects(path: string): Promise<number> {
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

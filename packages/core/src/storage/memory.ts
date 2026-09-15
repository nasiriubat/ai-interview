import { Readable } from "node:stream";
import {
  assertSafeKey,
  ObjectNotFound,
  ObjectTooLarge,
  type PutOptions,
  type StoragePort,
  type StoredObject,
} from "./port.js";

/** Keeps objects in a map. Used by tests, and by a development run with no upload directory set. */
export class MemoryStorage implements StoragePort {
  private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer | Readable, options: PutOptions): Promise<StoredObject> {
    assertSafeKey(key);
    const buffer = Buffer.isBuffer(body) ? body : await collect(body, options.maxBytes);
    if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
      throw new ObjectTooLarge(options.maxBytes, buffer.byteLength);
    }
    this.objects.set(key, { body: buffer, contentType: options.contentType });
    return { key, contentType: options.contentType, sizeBytes: buffer.byteLength };
  }

  async get(key: string): Promise<Readable> {
    const found = this.objects.get(assertSafeKey(key));
    if (!found) throw new ObjectNotFound(key);
    return Readable.from(found.body);
  }

  async head(key: string): Promise<StoredObject | null> {
    const found = this.objects.get(assertSafeKey(key));
    if (!found) return null;
    return { key, contentType: found.contentType, sizeBytes: found.body.byteLength };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(assertSafeKey(key));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Test helper: how many objects are held. */
  get size(): number {
    return this.objects.size;
  }
}

/**
 * Reads a stream into memory, giving up as soon as it passes the limit rather than after.
 * An upload that lies about its length must not be able to exhaust the process first.
 */
export async function collect(body: Readable, maxBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      body.destroy();
      throw new ObjectTooLarge(maxBytes, total);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

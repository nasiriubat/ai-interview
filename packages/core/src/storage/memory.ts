import { Readable, pipeline } from "node:stream";
import {
  assertSafeKey,
  byteLimit,
  type PrefixInfo,
  ObjectNotFound,
  ObjectTooLarge,
  type PutOptions,
  type StoragePort,
  type StoredObject,
} from "./port.js";

/** Keeps objects in a map. Used by tests, and by a development run with no upload directory set. */
export class MemoryStorage implements StoragePort {
  private readonly objects = new Map<string, { body: Buffer; contentType: string; modifiedAt: Date }>();

  /** `now` is a test seam: it stamps each write, which the orphan sweep's grace window reads. */
  constructor(private readonly now: () => Date = () => new Date()) {}

  async put(key: string, body: Buffer | Readable, options: PutOptions): Promise<StoredObject> {
    assertSafeKey(key);
    const buffer = Buffer.isBuffer(body) ? body : await collect(body, options.maxBytes);
    if (options.maxBytes !== undefined && buffer.byteLength > options.maxBytes) {
      throw new ObjectTooLarge(options.maxBytes, buffer.byteLength);
    }
    this.objects.set(key, { body: buffer, contentType: options.contentType, modifiedAt: this.now() });
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

  async listPrefixes(parent: string): Promise<PrefixInfo[]> {
    const base = parent.endsWith("/") || parent === "" ? parent : `${parent}/`;
    const newest = new Map<string, Date>();
    for (const [key, obj] of this.objects) {
      if (!key.startsWith(base)) continue;
      const name = key.slice(base.length).split("/")[0];
      if (!name) continue;
      const seen = newest.get(name);
      if (!seen || obj.modifiedAt > seen) newest.set(name, obj.modifiedAt);
    }
    return [...newest].map(([name, modifiedAt]) => ({ name, modifiedAt }));
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
  const limited = pipeline(body, byteLimit(maxBytes), () => undefined);
  for await (const chunk of limited)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

import { Transform, type Readable, type TransformCallback } from "node:stream";

/**
 * Where uploaded bytes live: recorded audio, and the documents and images a participant attaches
 * (FR-30, FR-31). Database rows describe them; this holds the bytes themselves.
 *
 * A port rather than a direct dependency because the three deployments differ. Tests want nothing
 * on disk, a single VPS wants a Docker volume and no extra service to run or back up, and anyone
 * outgrowing one host wants object storage. All three satisfy the same five methods.
 */
export interface StoragePort {
  /** Writes an object, replacing anything already at that key. */
  put(key: string, body: Buffer | Readable, options: PutOptions): Promise<StoredObject>;
  /** Reads an object as a stream. Throws {@link ObjectNotFound} if the key does not exist. */
  get(key: string): Promise<Readable>;
  /** Metadata without the bytes, or null when the key does not exist. */
  head(key: string): Promise<StoredObject | null>;
  /** Removes one object. Removing a key that is not there is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Removes everything under a key prefix and answers how many objects went.
   *
   * This exists because deletion is a promise the product makes: a participant may delete their
   * session, and the nightly retention sweep drops sessions past their window. Both must take the
   * audio and attachments with them, and doing that one key at a time from the database means any
   * row lost along the way strands bytes that nobody can find but everybody is still storing.
   */
  deletePrefix(prefix: string): Promise<number>;
  /**
   * The immediate children of a prefix, with when anything under each last changed.
   *
   * This is what lets storage be reconciled against the database without a database row to start
   * from: the retention sweep lists a tenant's session directories and removes the ones whose
   * session no longer exists. `modifiedAt` is the newest write beneath the child, so a caller can
   * leave alone anything an in-flight upload may still be creating.
   */
  listPrefixes(parent: string): Promise<PrefixInfo[]>;
}

export interface PrefixInfo {
  /** One path segment, without separators. */
  name: string;
  modifiedAt: Date;
}

export interface PutOptions {
  contentType: string;
  /** Rejects the write if the body turns out to be larger. Enforced by every adapter. */
  maxBytes?: number;
}

export interface StoredObject {
  key: string;
  contentType: string;
  sizeBytes: number;
}

/** Thrown by {@link StoragePort.get} when the key is absent. */
export class ObjectNotFound extends Error {
  constructor(key: string) {
    super(`No stored object at ${key}`);
    this.name = "ObjectNotFound";
  }
}

/** Thrown when a body exceeds {@link PutOptions.maxBytes}. */
export class ObjectTooLarge extends Error {
  constructor(
    readonly maxBytes: number,
    readonly sizeBytes: number,
  ) {
    super(`Object is ${sizeBytes} bytes, over the ${maxBytes}-byte limit`);
    this.name = "ObjectTooLarge";
  }
}

/**
 * Thrown when the store has no room left for the object (D-283): a full disk or an exceeded quota.
 * The caller can tell the participant what happened instead of answering a bare 500; the operator
 * is told separately by the `disk.high` alert.
 */
export class StorageFull extends Error {
  constructor() {
    super("The object store has no space left");
    this.name = "StorageFull";
  }
}

/**
 * S3-compatible stores report "no room" under a few names, none of them standard: AWS and Hetzner
 * say `QuotaExceeded` or `StorageQuotaExceeded`, Backblaze B2 `storage_cap_exceeded`, some
 * gateways `InsufficientStorage` or `NoSpaceLeft`; WebDAV-style gateways answer HTTP 507. The
 * match is on the error's code or name, never its message (free text that may carry a bucket
 * name), so an SDK error and a plain `{ code }` object are both recognised.
 */
const OUT_OF_SPACE_CODES = new Set(
  [
    "ENOSPC",
    "EDQUOT",
    "QuotaExceeded",
    "StorageQuotaExceeded",
    "BucketQuotaExceeded",
    "AccountQuotaExceeded",
    "storage_cap_exceeded",
    "InsufficientStorage",
    "NoSpaceLeft",
  ].map((c) => c.toLowerCase()),
);

function labelsOf(err: object): string[] {
  const e = err as { code?: unknown; Code?: unknown; name?: unknown };
  return [e.code, e.Code, e.name].filter((v): v is string => typeof v === "string");
}

/**
 * Whether a failure from the file system, an object store or the network is "no room left":
 * `ENOSPC` and `EDQUOT` from a disk, a quota code from an S3-compatible store, or HTTP 507. Looks
 * through `cause` (bounded) because adapters wrap what they catch.
 */
export function isOutOfSpace(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    if (labelsOf(current).some((l) => OUT_OF_SPACE_CODES.has(l.toLowerCase()))) return true;
    const e = current as {
      statusCode?: unknown;
      status?: unknown;
      $metadata?: { httpStatusCode?: unknown };
      cause?: unknown;
    };
    if ([e.statusCode, e.status, e.$metadata?.httpStatusCode].includes(507)) return true;
    current = e.cause;
  }
  return false;
}

/**
 * Passes bytes through and fails the pipeline the moment more than `maxBytes` have gone by.
 *
 * Used by every adapter so the cap is one implementation, applied with backpressure: a pipeline
 * built on this reads no faster than it writes, so an upload that is larger than its cap never
 * sits in memory, however fast the sender is. The caller finds out at `maxBytes + 1`, not after
 * the last byte.
 */
export function byteLimit(maxBytes: number | undefined): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
      total += chunk.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        cb(new ObjectTooLarge(maxBytes, total));
        return;
      }
      cb(null, chunk);
    },
  });
}

/**
 * Builds the key for one attachment's bytes.
 *
 * Tenant first, then session: the layout is what makes {@link StoragePort.deletePrefix} usable for
 * "forget this session" and "forget this tenant" without consulting the database, and it keeps one
 * tenant's files from being interleaved with another's in whatever the adapter writes to.
 */
export function attachmentKey(companyId: string, sessionId: string, attachmentId: string): string {
  return `${segment(companyId)}/${segment(sessionId)}/${segment(attachmentId)}`;
}

/** Every key under one session, for deleting a session's bytes. */
export function sessionPrefix(companyId: string, sessionId: string): string {
  return `${segment(companyId)}/${segment(sessionId)}/`;
}

/** Every key under one tenant. */
export function companyPrefix(companyId: string): string {
  return `${segment(companyId)}/`;
}

/**
 * Keys are built from database identifiers, which are cuids, so this should never fire. It is here
 * because the filesystem adapter turns a key into a path, and "should never" is not a security
 * boundary: one identifier that ever comes from a request instead of a row, and `..` walks out of
 * the upload directory.
 */
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function segment(value: string): string {
  if (!SEGMENT.test(value)) throw new Error(`Unsafe storage key segment: ${JSON.stringify(value)}`);
  return value;
}

/** Validates a whole key the same way, for adapters that receive one from outside. */
export function assertSafeKey(key: string): string {
  const parts = key.split("/");
  if (parts.length === 0 || parts.length > 8) throw new Error(`Unsafe storage key: ${key}`);
  for (const part of parts) segment(part);
  return key;
}

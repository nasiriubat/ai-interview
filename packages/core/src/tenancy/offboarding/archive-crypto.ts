import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Sealing a tenant export (D-225): AES-256-GCM in 1 MiB segments, so an archive of several
 * gigabytes is encrypted and decrypted as a stream and never held in memory.
 *
 * Layout: `MAGIC | kid-length(1) | kid | nonce-prefix(4) | segment*`, each segment
 * `length(4, big-endian) | ciphertext | tag(16)`. A segment's nonce is the 4-byte prefix followed
 * by its 8-byte counter, and its additional authenticated data is the counter and a flag that is 1
 * only on the final segment, so segments cannot be reordered, dropped from the middle, or the
 * archive truncated at a segment boundary without the open failing.
 */

const MAGIC = Buffer.from("AIDPX1\n", "utf8");
export const SEGMENT_BYTES = 1024 * 1024;
const TAG_BYTES = 16;

function nonce(prefix: Buffer, counter: number): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
}

function aadFor(counter: number, last: boolean): Buffer {
  const a = Buffer.alloc(9);
  a.writeBigUInt64BE(BigInt(counter), 0);
  a.writeUInt8(last ? 1 : 0, 8);
  return a;
}

/** Seals a byte stream. Yields the header first, then one framed segment per `SEGMENT_BYTES`. */
export async function* sealStream(
  source: AsyncIterable<Uint8Array>,
  keyId: string,
  key: Buffer,
): AsyncGenerator<Buffer> {
  const kid = Buffer.from(keyId, "utf8");
  const prefix = randomBytes(4);
  yield Buffer.concat([MAGIC, Buffer.from([kid.length]), kid, prefix]);
  let counter = 0;
  const seal = (plain: Buffer, last: boolean): Buffer => {
    const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, counter));
    cipher.setAAD(aadFor(counter, last));
    const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    counter++;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ct.length, 0);
    return Buffer.concat([len, ct]);
  };
  let pending: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    pending.push(Buffer.from(chunk));
    size += chunk.byteLength;
    while (size > SEGMENT_BYTES) {
      // Strictly more than one segment is buffered, so the segment cut here is never the last.
      const all = Buffer.concat(pending);
      yield seal(all.subarray(0, SEGMENT_BYTES), false);
      const rest = all.subarray(SEGMENT_BYTES);
      pending = rest.length ? [rest] : [];
      size = rest.length;
    }
  }
  yield seal(Buffer.concat(pending), true);
}

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveFormatError";
  }
}

/** The key id a sealed archive names, read from its first bytes. */
export function readKeyId(head: Buffer): string {
  if (head.length < MAGIC.length + 1 || !head.subarray(0, MAGIC.length).equals(MAGIC))
    throw new ArchiveFormatError("Not a sealed export archive");
  const len = head.readUInt8(MAGIC.length);
  if (head.length < MAGIC.length + 1 + len) throw new ArchiveFormatError("Truncated archive header");
  return head.subarray(MAGIC.length + 1, MAGIC.length + 1 + len).toString("utf8");
}

/** Opens a sealed stream. Throws `ArchiveFormatError` or a GCM failure on any tampering or truncation. */
export async function* openStream(
  source: AsyncIterable<Uint8Array>,
  keyFor: (keyId: string) => Buffer | null,
): AsyncGenerator<Buffer> {
  let buf = Buffer.alloc(0);
  let counter = 0;
  let sawLast = false;

  const iterator = source[Symbol.asyncIterator]();
  const fill = async (n: number): Promise<boolean> => {
    while (buf.length < n) {
      const r = await iterator.next();
      if (r.done) return false;
      buf = Buffer.concat([buf, Buffer.from(r.value)]);
    }
    return true;
  };

  if (!(await fill(MAGIC.length + 1))) throw new ArchiveFormatError("Not a sealed export archive");
  const kidLen = buf.readUInt8(MAGIC.length);
  if (!(await fill(MAGIC.length + 1 + kidLen + 4))) throw new ArchiveFormatError("Truncated archive header");
  const keyId = readKeyId(buf);
  const key = keyFor(keyId);
  if (!key) throw new ArchiveFormatError(`The archive is sealed under key ${keyId}, which is not available`);
  const prefix = buf.subarray(MAGIC.length + 1 + kidLen, MAGIC.length + 1 + kidLen + 4);
  buf = buf.subarray(MAGIC.length + 1 + kidLen + 4);

  for (;;) {
    if (!(await fill(4))) break;
    const len = buf.readUInt32BE(0);
    if (len < TAG_BYTES || len > SEGMENT_BYTES + TAG_BYTES)
      throw new ArchiveFormatError("Corrupt segment length");
    if (!(await fill(4 + len))) throw new ArchiveFormatError("Archive is truncated");
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    // Whether this is the last segment is known only from what follows it.
    const last = buf.length === 0 && !(await fill(1));
    const decipher = createDecipheriv("aes-256-gcm", key, nonce(prefix, counter));
    decipher.setAAD(aadFor(counter, last));
    decipher.setAuthTag(body.subarray(len - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(body.subarray(0, len - TAG_BYTES)), decipher.final()]);
    counter++;
    yield plain;
    if (last) {
      sawLast = true;
      break;
    }
  }
  if (!sawLast) throw new ArchiveFormatError("Archive is truncated");
}

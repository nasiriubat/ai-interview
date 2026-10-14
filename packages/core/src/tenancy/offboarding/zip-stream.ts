import { crc32 } from "../../requirements/zip.js";

/**
 * A streaming zip writer for tenant exports (D-225). The agent-bundle writer in
 * `requirements/zip.ts` builds the archive in memory, which is right for a few kilobytes of
 * Markdown and wrong for a tenant's recordings. This one yields bytes as entries are produced and
 * holds one chunk at a time.
 *
 * Entries are stored, not deflated (audio and office files are already compressed; the JSON lines
 * are the small part), with the sizes and CRC in a trailing data descriptor (general-purpose flag
 * bit 3), which every unzip tool reads. No ZIP64: a single entry or an archive over 4 GiB is
 * refused rather than written wrong.
 */

const UTF8_AND_DESCRIPTOR = 0x0808;
const MAX = 0xffffffff;

export class ZipTooLargeError extends Error {
  constructor() {
    super("The archive would exceed 4 GiB, which this writer does not support");
    this.name = "ZipTooLargeError";
  }
}

export interface StreamEntry {
  /** Forward slashes, no leading slash, no `..`. */
  path: string;
  data: AsyncIterable<Uint8Array> | Uint8Array | string;
}

function safePath(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.split("/").some((p) => p === ".." || p === "")) throw new Error(`Unsafe zip path: ${path}`);
  return clean;
}

function dos(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

/** A running CRC-32 that can take its input in pieces. */
class Crc {
  private value = 0;
  /** `crc32` of the concatenation, computed incrementally by chaining on the previous value. */
  update(chunk: Buffer): void {
    this.value = crcContinue(this.value, chunk);
  }
  get result(): number {
    return this.value >>> 0;
  }
}

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crcContinue(previous: number, chunk: Buffer): number {
  let crc = (previous ^ 0xffffffff) >>> 0;
  for (const byte of chunk) crc = (TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Yields a zip archive as it is built. `entries` may itself be produced lazily. */
export async function* streamZip(
  entries: AsyncIterable<StreamEntry> | Iterable<StreamEntry>,
  modified: Date = new Date(),
): AsyncGenerator<Buffer> {
  const { time, date } = dos(modified);
  const central: Buffer[] = [];
  let offset = 0;

  const emit = (b: Buffer): Buffer => {
    offset += b.length;
    if (offset > MAX) throw new ZipTooLargeError();
    return b;
  };

  for await (const entry of entries as AsyncIterable<StreamEntry>) {
    const name = Buffer.from(safePath(entry.path), "utf8");
    const headerOffset = offset;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_AND_DESCRIPTOR, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // CRC and sizes are zero here and follow the data in the descriptor.
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    yield emit(local);

    const crc = new Crc();
    let size = 0;
    const data: AsyncIterable<Uint8Array> =
      typeof entry.data === "string"
        ? one(Buffer.from(entry.data, "utf8"))
        : entry.data instanceof Uint8Array
          ? one(entry.data)
          : entry.data;
    for await (const piece of data) {
      const chunk = Buffer.from(piece);
      if (chunk.length === 0) continue;
      crc.update(chunk);
      size += chunk.length;
      yield emit(chunk);
    }
    if (size > MAX) throw new ZipTooLargeError();

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc.result, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield emit(descriptor);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(UTF8_AND_DESCRIPTOR, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc.result, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(headerOffset, 42);
    name.copy(cd, 46);
    central.push(cd);
  }

  const cdStart = offset;
  for (const c of central) yield emit(c);
  const cdSize = offset - cdStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  yield emit(end);
}

async function* one(b: Uint8Array): AsyncGenerator<Uint8Array> {
  yield b;
}

/** Exposed for the tests, which check the incremental CRC against the one-shot function. */
export function crcOf(chunks: Buffer[]): number {
  const c = new Crc();
  for (const ch of chunks) c.update(ch);
  return c.result;
}

export { crc32 };

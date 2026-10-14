import { createInflateRaw } from "node:zlib";
import { IngestRejected, type IngestLimits } from "./limits.js";

/**
 * A pre-flight for DOCX and XLSX, which are zip containers (P11, D-160).
 *
 * Declared sizes in a zip are claims by the author of the file. A bomb declares a few kilobytes
 * and inflates to gigabytes, and an overlapping-entry bomb points many headers at one compressed
 * stream. So this walks the central directory only to learn what to read, then inflates every
 * entry for real in bounded chunks, counts the bytes actually produced, and stops the moment a
 * limit is passed. Nothing is kept: output is scanned and dropped, so memory stays flat however
 * hostile the input.
 *
 * It also refuses any XML part that declares a DOCTYPE or ENTITY. Office files never need one, and
 * a DTD is how an entity-expansion ("billion laughs") bomb reaches the XML parser downstream.
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export type OfficeKind = "docx" | "xlsx";

export interface ZipEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  declaredSize: number;
  localOffset: number;
}

export interface ZipReport {
  entries: number;
  uncompressedBytes: number;
  /** Inflated size of each part, as counted while inflating. */
  parts: { name: string; bytes: number }[];
  kind: OfficeKind | "other";
}

export interface ZipDirectory {
  names: string[];
  kind: OfficeKind | "other";
}

/**
 * Names in the central directory, from a buffer that holds the end of the file. Returns null when
 * the buffer does not contain a complete directory (the upload path keeps only a tail), which is
 * "cannot tell yet", not "bad".
 */
export function readZipDirectory(tail: Buffer): ZipDirectory | null {
  const located = locateDirectory(tail);
  if (!located) return null;
  const { start, count } = located;
  if (start < 0) return null;
  const names: string[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    if (p + 46 > tail.length || tail.readUInt32LE(p) !== CEN_SIG) return null;
    const nameLen = tail.readUInt16LE(p + 28);
    const extraLen = tail.readUInt16LE(p + 30);
    const commentLen = tail.readUInt16LE(p + 32);
    if (p + 46 + nameLen > tail.length) return null;
    names.push(tail.toString("utf8", p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { names, kind: kindOf(names) };
}

function kindOf(names: string[]): OfficeKind | "other" {
  if (names.includes("word/document.xml")) return "docx";
  if (names.includes("xl/workbook.xml")) return "xlsx";
  return "other";
}

function locateDirectory(buf: Buffer): { start: number; count: number; size: number } | null {
  // The end record is at most 22 bytes plus a 65535-byte comment from the end.
  const from = Math.max(0, buf.length - 22 - 0xffff);
  for (let p = buf.length - 22; p >= from; p--) {
    if (buf.readUInt32LE(p) !== EOCD_SIG) continue;
    const count = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 12);
    const offset = buf.readUInt32LE(p + 16);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new IngestRejected("zip_malformed", "That file uses a container format that is not supported");
    }
    // `buf` may start mid-file: the directory sits immediately before the end record.
    return { start: p - size, count, size };
  }
  return null;
}

function parseEntries(buf: Buffer, limits: IngestLimits): ZipEntryInfo[] {
  const loc = locateDirectory(buf);
  if (!loc || loc.start < 0) {
    throw new IngestRejected("zip_malformed", "That file is not a valid Office document");
  }
  if (loc.count > limits.maxZipEntries) {
    throw new IngestRejected("zip_entries", "That file has too many parts to be a normal document");
  }
  const entries: ZipEntryInfo[] = [];
  let p = loc.start;
  for (let i = 0; i < loc.count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new IngestRejected("zip_malformed", "That file is not a valid Office document");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const declaredSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (flags & 0x1) throw new IngestRejected("zip_encrypted", "That document is password protected");
    if (compressedSize === 0xffffffff || declaredSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new IngestRejected("zip_malformed", "That file uses a container format that is not supported");
    }
    if (method !== 0 && method !== 8) {
      throw new IngestRejected("zip_malformed", "That file uses a compression method that is not supported");
    }
    if (p + 46 + nameLen > buf.length) {
      throw new IngestRejected("zip_malformed", "That file is not a valid Office document");
    }
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      method,
      compressedSize,
      declaredSize,
      localOffset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function inspectZip(
  bytes: Buffer,
  limits: IngestLimits,
  expect?: OfficeKind,
): Promise<ZipReport> {
  const entries = parseEntries(bytes, limits);
  const kind = kindOf(entries.map((e) => e.name));
  if (expect && kind !== expect) {
    throw new IngestRejected(
      "zip_wrong_kind",
      expect === "docx"
        ? "That file is not a Word document, whatever its name says"
        : "That file is not an Excel workbook, whatever its name says",
    );
  }

  let total = 0;
  const parts: { name: string; bytes: number }[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    if (entry.localOffset + 30 > bytes.length || bytes.readUInt32LE(entry.localOffset) !== LOC_SIG) {
      throw new IngestRejected("zip_malformed", "That file is not a valid Office document");
    }
    const nameLen = bytes.readUInt16LE(entry.localOffset + 26);
    const extraLen = bytes.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) {
      throw new IngestRejected("zip_malformed", "That file is not a valid Office document");
    }
    const produced = await scanEntry(bytes.subarray(dataStart, dataEnd), entry.method, {
      isXml: /\.(xml|rels|vml)$/i.test(entry.name),
      budget: limits.maxUncompressedBytes - total,
    });
    total += produced;
    parts.push({ name: entry.name, bytes: produced });
    const ratio = entry.compressedSize === 0 ? Infinity : produced / entry.compressedSize;
    // Small parts of repetitive XML can legitimately exceed any ratio; only large output counts.
    if (produced > 1024 * 1024 && ratio > limits.maxZipRatio) {
      throw new IngestRejected("zip_ratio", "That file compresses far more than a normal document does");
    }
  }
  return { entries: entries.length, uncompressedBytes: total, parts, kind };
}

const DTD = /<!(DOCTYPE|ENTITY)/i;

/** Inflates one entry, returning how many bytes it really produced. Rejects past the budget. */
function scanEntry(
  compressed: Buffer,
  method: number,
  opts: { isXml: boolean; budget: number },
): Promise<number> {
  return new Promise((resolve, reject) => {
    let produced = 0;
    let tail = "";
    let first = true;
    const onChunk = (chunk: Buffer): Error | null => {
      produced += chunk.length;
      if (produced > opts.budget) {
        return new IngestRejected(
          "zip_size",
          "That file is far larger once unpacked than a document should be",
        );
      }
      if (opts.isXml) {
        if (first) {
          first = false;
          // UTF-16 XML would hide a DTD from a byte-level scan, and Office never writes it.
          if (
            chunk.length >= 2 &&
            ((chunk[0] === 0xff && chunk[1] === 0xfe) || (chunk[0] === 0xfe && chunk[1] === 0xff))
          ) {
            return new IngestRejected("xml_doctype", "That file contains markup that is not allowed");
          }
        }
        // latin1 keeps one char per byte, so the 16-char overlap cannot split a match.
        const text = tail + chunk.toString("latin1");
        if (DTD.test(text)) {
          return new IngestRejected("xml_doctype", "That file contains markup that is not allowed");
        }
        tail = text.slice(-16);
      }
      return null;
    };

    if (method === 0) {
      for (let i = 0; i < compressed.length; i += 65536) {
        const err = onChunk(compressed.subarray(i, i + 65536));
        if (err) {
          reject(err);
          return;
        }
      }
      resolve(produced);
      return;
    }

    const inflate = createInflateRaw();
    let failed = false;
    const fail = (err: Error): void => {
      if (failed) return;
      failed = true;
      inflate.destroy();
      reject(err);
    };
    inflate.on("data", (chunk: Buffer) => {
      const err = onChunk(chunk);
      if (err) fail(err);
    });
    inflate.on("error", () => {
      fail(new IngestRejected("zip_malformed", "That file is not a valid Office document"));
    });
    inflate.on("end", () => {
      if (!failed) resolve(produced);
    });
    // Written in slices so a hostile entry is cut off near the limit instead of after the inflater
    // has been handed, and has queued output for, the whole compressed body.
    let offset = 0;
    const pump = (): void => {
      if (failed) return;
      if (offset >= compressed.length) {
        inflate.end();
        return;
      }
      const end = Math.min(offset + 16384, compressed.length);
      const ok = inflate.write(compressed.subarray(offset, end));
      offset = end;
      if (ok) setImmediate(pump);
      else inflate.once("drain", pump);
    };
    pump();
  });
}

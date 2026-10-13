import { Transform, type TransformCallback } from "node:stream";
import { IngestRejected } from "./limits.js";
import { readZipDirectory } from "./zip-guard.js";

/**
 * Does the content of an upload match the type it was declared as? (P11, D-160)
 *
 * The declared type comes from the browser and the filename from the participant, so neither says
 * anything about the bytes. Signatures are hand-written for the eight types the catalog allows
 * plus recorded audio: small, no native code, and nothing to keep patched. A library such as
 * `file-type` would add a dependency to say the same eight things.
 *
 * The check runs as a stream transform, so the upload is never held whole. It looks at the first
 * chunk for a signature, watches the whole stream for the properties of text (no NUL bytes,
 * almost no control characters), and keeps only the last 512 KB so that a zip's central directory
 * can confirm a DOCX is a Word document and not any other container.
 */

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const TAIL_BYTES = 512 * 1024;

export type SniffedKind = "pdf" | "zip" | "png" | "jpeg" | "audio" | "text" | "unknown";

/** The family of signature a declared MIME type must show. */
function expectedKind(mime: string): SniffedKind | null {
  const base = (mime.split(";")[0] ?? "").trim().toLowerCase();
  if (base === "application/pdf") return "pdf";
  if (base === DOCX || base === XLSX) return "zip";
  if (base === "image/png") return "png";
  if (base === "image/jpeg") return "jpeg";
  if (base.startsWith("audio/")) return "audio";
  if (base === "text/plain" || base === "text/markdown" || base === "text/csv") return "text";
  return null;
}

/** Signature of the leading bytes, or "unknown". Text is decided over the whole stream instead. */
export function sniffHead(head: Buffer): SniffedKind {
  const startsWith = (sig: number[], at = 0): boolean => sig.every((b, i) => head[at + i] === b);
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith([0xff, 0xd8, 0xff])) return "jpeg";
  if (
    startsWith([0x1a, 0x45, 0xdf, 0xa3]) || // WebM, Matroska
    startsWith([0x4f, 0x67, 0x67, 0x53]) || // Ogg
    startsWith([0x66, 0x4c, 0x61, 0x43]) || // FLAC
    startsWith([0x49, 0x44, 0x33]) || // ID3 tag before MP3
    (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) || // MPEG frame sync
    (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x41, 0x56, 0x45], 8)) || // RIFF WAVE
    startsWith([0x66, 0x74, 0x79, 0x70], 4) // ISO base media (m4a, mp4, 3gp)
  ) {
    return "audio";
  }
  // A PDF may carry a little junk before its header, but the header must be there.
  if (head.subarray(0, 1024).includes("%PDF-")) return "pdf";
  return "unknown";
}

/**
 * Transform that passes bytes through untouched and fails the pipeline when they are not what
 * was declared. Failing inside the pipeline is what makes the storage adapter discard its
 * partial object, so a rejected upload leaves nothing behind.
 */
export class UploadInspector extends Transform {
  private seen = 0;
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private control = 0;
  private readonly want: SniffedKind | null;
  private checkedHead = false;

  constructor(private readonly declaredMime: string) {
    super();
    this.want = expectedKind(declaredMime);
  }

  /** Bytes that have passed through. */
  get bytes(): number {
    return this.seen;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.seen += chunk.length;
      if (!this.checkedHead) {
        this.head = Buffer.concat([this.head, chunk]).subarray(0, 2048);
        // Wait for a few bytes so a split first chunk cannot cause a false rejection.
        if (this.head.length >= 16 || this.seen === this.head.length) this.verifyHead();
      }
      if (this.want === "text") this.scanText(chunk);
      if (this.want === "zip") {
        this.tail = Buffer.concat([this.tail, chunk]);
        if (this.tail.length > TAIL_BYTES * 2) this.tail = this.tail.subarray(this.tail.length - TAIL_BYTES);
      }
      cb(null, chunk);
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      if (!this.checkedHead) this.verifyHead();
      if (this.seen === 0) throw mismatch("That file is empty");
      if (this.want === "zip") this.confirmZip();
      if (this.want === "text" && this.seen > 0 && this.control / this.seen > 0.01) {
        throw mismatch("That file does not look like text");
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  private verifyHead(): void {
    this.checkedHead = true;
    if (this.want === null) {
      // The type was admitted by the catalog but has no signature here: never silently allow.
      throw mismatch("That file type is not accepted");
    }
    if (this.want === "text") return;
    const found = sniffHead(this.head);
    if (found !== this.want) {
      throw mismatch(
        this.want === "audio"
          ? "That recording could not be read, so please type your answer instead"
          : `That file is not really ${describe(this.want)}, whatever its name says`,
      );
    }
  }

  private scanText(chunk: Buffer): void {
    for (const b of chunk) {
      if (b === 0) throw mismatch("That file is not plain text");
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) this.control++;
    }
  }

  private confirmZip(): void {
    const kind = this.declaredMime.includes("wordprocessingml") ? "docx" : "xlsx";
    let dir;
    try {
      dir = readZipDirectory(this.tail);
    } catch (err) {
      if (err instanceof IngestRejected) throw err;
      return;
    }
    // A directory too large for the tail is judged at ingest, where the whole file is available.
    if (dir && dir.kind !== kind) {
      throw mismatch(
        `That file is not really ${describe(kind === "docx" ? "docx" : "xlsx")}, whatever its name says`,
      );
    }
  }
}

function describe(kind: string): string {
  switch (kind) {
    case "pdf":
      return "a PDF";
    case "zip":
    case "docx":
      return "a Word document";
    case "xlsx":
      return "an Excel workbook";
    case "png":
      return "a PNG image";
    case "jpeg":
      return "a JPEG image";
    case "audio":
      return "a recording";
    default:
      return "that type";
  }
}

function mismatch(message: string): IngestRejected {
  return new IngestRejected("content_mismatch", message);
}

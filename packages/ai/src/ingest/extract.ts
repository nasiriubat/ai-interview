import { DEFAULT_INGEST_LIMITS, IngestRejected, type IngestLimits } from "./limits.js";
import { inspectZip } from "./zip-guard.js";

/**
 * Turning an uploaded file into text (FR-31).
 *
 * No model is involved here, and that is the point: a PDF's text is in the PDF, and asking a model
 * to read it back would cost money, take seconds and invent words. The model is used for the two
 * things extraction cannot do — describing an image, and summarizing what was extracted.
 *
 * Every parser is loaded with a dynamic `import` at the moment its format turns up. The PDF, DOCX
 * and XLSX libraries together are far larger than the rest of this package, the API imports this
 * module to validate uploads, and almost every interview attaches nothing at all. Paying for three
 * parsers at boot, in every process, to serve the occasional spreadsheet is the wrong trade.
 */

/** What extraction produced, and how confident we are that it is worth reading. */
export interface Extracted {
  text: string;
  /** Pages for a PDF, sheets for a workbook, undefined where the idea does not apply. */
  parts?: number;
  /**
   * True when the file parsed but yielded almost nothing — a scanned PDF is the usual case.
   * The caller turns this into a message the participant can act on ("I could not read any text
   * in that; it looks like a scan") rather than silently attaching an empty document.
   */
  empty: boolean;
}

/** Formats this module can read without a model. Images go to `vision_ingest` instead. */
export const TEXT_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/markdown",
  "text/plain",
  "text/csv",
] as const;

export const IMAGE_MIMES = ["image/png", "image/jpeg"] as const;

export type TextMime = (typeof TEXT_MIMES)[number];
export type ImageMime = (typeof IMAGE_MIMES)[number];

export function isTextMime(mime: string): mime is TextMime {
  return (TEXT_MIMES as readonly string[]).includes(mime);
}

export function isImageMime(mime: string): mime is ImageMime {
  return (IMAGE_MIMES as readonly string[]).includes(mime);
}

/** The attachment `kind` column, from the MIME type. */
export function kindForMime(mime: string): "document" | "image" | "audio" | null {
  if (isTextMime(mime)) return "document";
  if (isImageMime(mime)) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

/** Below this many characters a parse is treated as having found nothing worth keeping. */
const EMPTY_BELOW = 20;

/**
 * Reads one file. Every parser sits behind a limit (P11, D-160): zip containers are inflated and
 * counted before a parser sees them, a PDF's page count is checked before any page is parsed, a
 * workbook is read as a stream with a cell budget, and output is cut at `maxExtractedChars`.
 *
 * This function runs in the caller's thread. Production callers use `extractIsolated`, which runs
 * it in a worker with a heap limit and a deadline; the limits here are what keep that worker's
 * work, and its memory, proportionate.
 */
export async function extractText(
  bytes: Buffer,
  mime: string,
  limits: IngestLimits = DEFAULT_INGEST_LIMITS,
): Promise<Extracted> {
  const out = await extractRaw(bytes, mime, limits);
  const text =
    out.text.length > limits.maxExtractedChars ? out.text.slice(0, limits.maxExtractedChars) : out.text;
  return { ...out, text, empty: text.length < EMPTY_BELOW };
}

async function extractRaw(bytes: Buffer, mime: string, limits: IngestLimits): Promise<Extracted> {
  switch (mime) {
    case "application/pdf":
      return await extractPdf(bytes, limits);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      await inspectZip(bytes, limits, "docx");
      return await extractDocx(bytes);
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      await inspectZip(bytes, limits, "xlsx");
      return await extractXlsx(bytes, limits);
    case "text/csv":
    case "text/markdown":
    case "text/plain":
      return plain(decodeText(bytes));
    default:
      throw new Error(`No text extractor for ${mime}`);
  }
}

async function extractPdf(bytes: Buffer, limits: IngestLimits): Promise<Extracted> {
  const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
  let doc;
  try {
    // No XFA forms, no system fonts, bounded images: a PDF is read as data, never run.
    doc = await getDocumentProxy(new Uint8Array(bytes), {
      maxImageSize: 16_777_216,
      enableXfa: false,
      useSystemFonts: false,
      disableFontFace: true,
    });
  } catch {
    throw new IngestRejected("pdf_malformed", "That PDF could not be read");
  }
  if (doc.numPages > limits.maxPdfPages) {
    const pages = doc.numPages;
    await doc.cleanup();
    throw new IngestRejected("pdf_pages", `That PDF has ${pages} pages; the limit is ${limits.maxPdfPages}`);
  }
  const { text, totalPages } = await pdfText(doc, { mergePages: true });
  await doc.cleanup();
  const merged = normalizeText(Array.isArray(text) ? text.join("\n\n") : text);
  return { text: merged, parts: totalPages, empty: merged.length < EMPTY_BELOW };
}

async function extractDocx(bytes: Buffer): Promise<Extracted> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  const text = normalizeText(value);
  return { text, empty: text.length < EMPTY_BELOW };
}

/**
 * A worksheet becomes one line per row with tab-separated cells, under a heading per sheet.
 *
 * Deliberately not a faithful rendering of the spreadsheet. What the interview needs is the words
 * and numbers in reading order — "which systems does this team use", "how long does this step
 * take" — and a layout-preserving dump costs many more tokens to say the same thing. Formulas are
 * rendered as their last computed result, which is what a person reading the sheet would see.
 *
 * Bounded before it is parsed rather than while: exceljs's streaming reader fails on ordinary
 * files whose parts are not in the order it assumes, so the workbook is loaded whole, after the
 * zip guard has capped the inflated size and each sheet's XML has been held to `maxSheetCells`
 * times a generous per-cell byte budget. What remains is bounded by the worker's heap limit.
 */
async function extractXlsx(bytes: Buffer, limits: IngestLimits): Promise<Extracted> {
  const report = await inspectZip(bytes, limits, "xlsx");
  const sheetXmlBytes = report.parts
    .filter((p) => /^xl\/worksheets\/[^/]+\.xml$/i.test(p.name))
    .reduce((n, p) => Math.max(n, p.bytes), 0);
  if (sheetXmlBytes > limits.maxSheetCells * BYTES_PER_CELL_BUDGET) {
    throw new IngestRejected("sheet_cells", "That workbook has more cells than can be read");
  }
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  // exceljs wants an ArrayBuffer; a Buffer is a view onto a possibly larger pooled one, so copy.
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  const out: string[] = [];
  let sheets = 0;
  let cells = 0;
  let chars = 0;
  for (const sheet of workbook.worksheets) {
    sheets++;
    out.push(`## ${sheet.name}`);
    const state = { stop: false };
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (state.stop) return;
      const parts: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => parts.push(cellText(cell.value)));
      cells += parts.length;
      const line = parts.join("\t").trimEnd();
      if (line.length > 0) {
        out.push(line);
        chars += line.length + 1;
      }
      // Text past the cap would be discarded anyway; stop collecting rather than finish the sheet.
      if (chars > limits.maxExtractedChars) state.stop = true;
    });
    if (cells > limits.maxSheetCells) {
      throw new IngestRejected("sheet_cells", "That workbook has more cells than can be read");
    }
    out.push("");
    if (state.stop) break;
  }
  const text = normalizeText(out.join("\n"));
  return { text, parts: sheets, empty: text.length < EMPTY_BELOW };
}

/** Upper bound for the bytes one cell takes in worksheet XML, with its reference and style. */
const BYTES_PER_CELL_BUDGET = 100;

/** ExcelJS cell values are a union of a dozen shapes; this flattens them to what a reader sees. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (v.result !== undefined) return cellText(v.result);
    if (typeof v.text === "string") return v.text;
  }
  return "";
}

function plain(text: string): Extracted {
  const normalized = normalizeText(text);
  return { text: normalized, empty: normalized.length < EMPTY_BELOW };
}

/**
 * Decodes bytes as UTF-8, dropping a byte-order mark.
 *
 * A file that is not valid UTF-8 decodes to replacement characters rather than throwing, because a
 * CSV exported from a spreadsheet on Windows is a normal thing for a participant to attach and
 * refusing it outright helps nobody. The text is still mostly readable, and the summary step will
 * make sense of it.
 */
function decodeText(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Collapses the runs of whitespace that every extractor produces, without losing paragraphs — or
 * columns.
 *
 * A run containing a tab collapses to a tab, not a space. In a spreadsheet the column boundary is
 * the meaning: flattening `Observations<TAB>45<TAB>Patient system` into spaces turns three
 * labelled values into a sentence that no longer says which number belongs to which heading, and
 * both the summary and every recalled chunk inherit the ambiguity.
 *
 * Non-breaking spaces are folded in with the ordinary ones. They arrive constantly from PDFs and
 * from anything pasted out of Word, and left alone they defeat every later `split(/\s+/)`.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, (run) => (run.includes("\t") ? "\t" : " "))
    .replace(/[ \t]?\n[ \t]?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

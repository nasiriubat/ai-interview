/**
 * What reading an untrusted file may cost (P11, D-160).
 *
 * Every number here comes from the settings catalog (`files.*`), so a tenant's admin or the
 * operator can tighten them without a deploy. The defaults below are the same values as the
 * catalog defaults; they exist for callers with no settings service, such as tests.
 */
export interface IngestLimits {
  /** Text kept from one file. Anything beyond is cut, not an error: the file is still useful. */
  maxExtractedChars: number;
  /** PDF pages. Above this the file is refused before any page is parsed. */
  maxPdfPages: number;
  /** Largest allowed ratio of inflated to deflated bytes in one zip entry (checked above 1 MB). */
  maxZipRatio: number;
  /** Cells read from a workbook. */
  maxSheetCells: number;
  /** Entries in a DOCX or XLSX container. */
  maxZipEntries: number;
  /** Inflated bytes across a whole container, counted as they are produced, not as declared. */
  maxUncompressedBytes: number;
  /** Wall clock for one extraction in the isolated worker. */
  timeoutMs: number;
  /** Old-generation heap ceiling for the worker. */
  workerHeapMb: number;
}

export const DEFAULT_INGEST_LIMITS: IngestLimits = {
  maxExtractedChars: 500_000,
  maxPdfPages: 200,
  maxZipRatio: 100,
  maxSheetCells: 1_000_000,
  maxZipEntries: 2000,
  maxUncompressedBytes: 100 * 1024 * 1024,
  timeoutMs: 60_000,
  workerHeapMb: 512,
};

export type IngestRejectCode =
  | "content_mismatch"
  | "zip_malformed"
  | "zip_encrypted"
  | "zip_entries"
  | "zip_size"
  | "zip_ratio"
  | "zip_wrong_kind"
  | "xml_doctype"
  | "pdf_pages"
  | "pdf_malformed"
  | "sheet_cells"
  | "timeout"
  | "memory"
  | "worker_failed";

/**
 * A file this system refuses to read. The message is plain because it reaches the participant
 * through `Attachment.error`; the code is what logs and tests match on.
 */
export class IngestRejected extends Error {
  constructor(
    readonly code: IngestRejectCode,
    message: string,
  ) {
    super(message);
    this.name = "IngestRejected";
  }
}

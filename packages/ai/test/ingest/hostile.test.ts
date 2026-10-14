import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { extractText } from "../../src/ingest/extract.js";
import {
  DEFAULT_INGEST_LIMITS,
  IngestRejected,
  type IngestLimits,
  type IngestRejectCode,
} from "../../src/ingest/limits.js";
import { extractIsolated, runInWorker } from "../../src/ingest/sandbox.js";
import { UploadInspector } from "../../src/ingest/sniff.js";
import { inspectZip } from "../../src/ingest/zip-guard.js";
import {
  makeDocx,
  makeEntityBombDocx,
  makeExe,
  makePdf,
  makePdfZipPolyglot,
  makeZip,
  makeZipBombDocx,
  utf16Text,
} from "./corpus.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const SMALL: IngestLimits = {
  ...DEFAULT_INGEST_LIMITS,
  maxUncompressedBytes: 8 * 1024 * 1024,
  maxZipEntries: 50,
  maxPdfPages: 20,
  timeoutMs: 20_000,
};

async function rejection(p: Promise<unknown>): Promise<IngestRejectCode> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(IngestRejected);
    return (err as IngestRejected).code;
  }
  throw new Error("expected the file to be rejected");
}

/** Runs `bytes` through the upload inspector the way the API does, and returns what it said. */
async function upload(bytes: Buffer, mime: string): Promise<IngestRejectCode | "accepted"> {
  const inspector = new UploadInspector(mime);
  const chunks: Buffer[] = [];
  try {
    await pipeline(Readable.from(chunkify(bytes, 7919)), inspector, async (src: AsyncIterable<Buffer>) => {
      for await (const c of src) chunks.push(c);
    });
    return "accepted";
  } catch (err) {
    if (err instanceof IngestRejected) return err.code;
    throw err;
  }
}

function* chunkify(buf: Buffer, size: number): Generator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

describe("hostile uploads are refused within limits (D-160)", () => {
  describe("at the door: content must match the declared type", () => {
    it("accepts honest files of each allowed type", async () => {
      expect(await upload(makePdf(1, "hi there from a pdf"), "application/pdf")).toBe("accepted");
      expect(await upload(makeDocx("an honest document"), DOCX)).toBe("accepted");
      expect(await upload(Buffer.from("# Notes\n\nÄiti ja öljy\n"), "text/markdown")).toBe("accepted");
      expect(await upload(Buffer.from("a,b\n1,2\n"), "text/csv")).toBe("accepted");
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(40),
      ]);
      expect(await upload(png, "image/png")).toBe("accepted");
      const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40)]);
      expect(await upload(webm, "audio/webm;codecs=opus")).toBe("accepted");
    });

    it("rejects an executable renamed to .pdf", async () => {
      expect(await upload(makeExe(), "application/pdf")).toBe("content_mismatch");
    });

    it("rejects a PDF declared as a Word document", async () => {
      expect(await upload(makePdf(1, "pdf pretending"), DOCX)).toBe("content_mismatch");
    });

    it("rejects a PDF-and-zip polyglot declared as Word", async () => {
      expect(await upload(makePdfZipPolyglot(), DOCX)).toBe("content_mismatch");
    });

    it("rejects an Excel container declared as Word, and a plain zip declared as either", async () => {
      const xlsxLike = makeZip([{ name: "xl/workbook.xml", data: Buffer.from("<workbook/>") }]);
      const plainZip = makeZip([{ name: "notes.txt", data: Buffer.from("hello") }]);
      expect(await upload(xlsxLike, DOCX)).toBe("content_mismatch");
      expect(await upload(plainZip, DOCX)).toBe("content_mismatch");
      expect(await upload(plainZip, XLSX)).toBe("content_mismatch");
    });

    it("rejects UTF-16 and binary content declared as text", async () => {
      expect(await upload(utf16Text("a,b,c\n1,2,3\n"), "text/csv")).toBe("content_mismatch");
      expect(await upload(makeExe(), "text/plain")).toBe("content_mismatch");
    });

    it("rejects an empty file and a declared type with no signature", async () => {
      expect(await upload(Buffer.alloc(0), "application/pdf")).toBe("content_mismatch");
      expect(await upload(Buffer.from("<svg/>"), "image/svg+xml")).toBe("content_mismatch");
    });

    it("decides on the first bytes even when they arrive in tiny pieces", async () => {
      const inspector = new UploadInspector("application/pdf");
      const bytes = makeExe();
      const outcome = await pipeline(
        Readable.from(chunkify(bytes, 3)),
        inspector,
        async (s: AsyncIterable<Buffer>) => {
          for await (const c of s) c.fill(0);
        },
      ).then(
        () => "accepted",
        (e: unknown) => (e as IngestRejected).code,
      );
      expect(outcome).toBe("content_mismatch");
    });
  });

  describe("containers: counted as inflated, whatever the headers claim", () => {
    it("rejects a zip bomb by output size, and memory stays bounded while doing it", async () => {
      const bomb = makeZipBombDocx(160 * 1024 * 1024);
      expect(bomb.length).toBeLessThan(600 * 1024);
      const before = process.memoryUsage();
      const code = await rejection(inspectZip(bomb, SMALL, "docx"));
      const after = process.memoryUsage();
      expect(code).toBe("zip_size");
      // Nothing is retained: the inflater is cut off at the budget (8 MB here).
      expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(80 * 1024 * 1024);
    });

    it("rejects a single entry above the ratio even when the total is within budget", async () => {
      const heavy = makeDocx("x", [{ name: "word/media/zeros.bin", data: Buffer.alloc(4 * 1024 * 1024) }]);
      expect(await rejection(inspectZip(heavy, SMALL, "docx"))).toBe("zip_ratio");
    });

    it("counts real output, not the size the headers declare", async () => {
      const liar = makeDocx("x", [
        { name: "word/media/zeros.bin", data: Buffer.alloc(40 * 1024 * 1024), declaredSize: 10 },
      ]);
      expect(await rejection(inspectZip(liar, SMALL, "docx"))).toBe("zip_size");
    });

    it("rejects too many entries before reading any of them", async () => {
      const many = makeZip(
        Array.from({ length: 200 }, (_, i) => ({ name: `word/p${i}.txt`, data: Buffer.from("x") })),
      );
      expect(await rejection(inspectZip(many, SMALL))).toBe("zip_entries");
    });

    it("rejects an XML entity bomb without ever handing it to the parser", async () => {
      const bomb = makeEntityBombDocx();
      expect(await rejection(extractText(bomb, DOCX, SMALL))).toBe("xml_doctype");
    });

    it("rejects a DOCTYPE hidden in UTF-16 XML", async () => {
      const xml = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<!DOCTYPE x []><a/>", "utf16le")]);
      const doc = makeZip([{ name: "word/document.xml", data: xml }]);
      expect(await rejection(inspectZip(doc, SMALL, "docx"))).toBe("xml_doctype");
    });

    it("rejects an encrypted entry", async () => {
      const zip = makeDocx("x");
      // Set general-purpose bit 0 in the first central-directory header.
      const at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      zip.writeUInt16LE(zip.readUInt16LE(at + 8) | 1, at + 8);
      expect(await rejection(inspectZip(zip, SMALL, "docx"))).toBe("zip_encrypted");
    });

    it("rejects a zip with no end record or a truncated body", async () => {
      const zip = makeDocx("x");
      expect(await rejection(inspectZip(zip.subarray(0, zip.length - 30), SMALL, "docx"))).toBe(
        "zip_malformed",
      );
    });

    it("still reads an honest document", async () => {
      const out = await extractText(makeDocx("An honest sentence about invoices."), DOCX, SMALL);
      expect(out.text).toContain("honest sentence about invoices");
    });
  });

  describe("PDF", () => {
    it("rejects a 5000-page PDF before parsing any page", async () => {
      const big = makePdf(5000);
      const t = Date.now();
      expect(await rejection(extractText(big, "application/pdf", SMALL))).toBe("pdf_pages");
      expect(Date.now() - t).toBeLessThan(15_000);
    });

    it("reads a small PDF", async () => {
      const out = await extractText(
        makePdf(1, "Quarterly invoices are re-keyed by hand"),
        "application/pdf",
        SMALL,
      );
      expect(out.text).toContain("re-keyed by hand");
    });

    it("rejects garbage that only starts like a PDF", async () => {
      const junk = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("not a pdf at all ".repeat(50))]);
      expect(await rejection(extractText(junk, "application/pdf", SMALL))).toBe("pdf_malformed");
    });
  });

  describe("text extraction is capped", () => {
    it("cuts text at the extracted-character limit", async () => {
      const long = Buffer.from("word ".repeat(10_000));
      const out = await extractText(long, "text/plain", { ...SMALL, maxExtractedChars: 1000 });
      expect(out.text.length).toBeLessThanOrEqual(1000);
    });
  });

  describe("workbooks", () => {
    it("reads an honest workbook and refuses one with too many cells", async () => {
      const ExcelJS = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet("Ward");
      for (let r = 0; r < 200; r++) sheet.addRow([`task ${r}`, r, "system"]);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());

      const ok = await extractText(buf, XLSX, SMALL);
      expect(ok.text).toContain("task 199");
      expect(await rejection(extractText(buf, XLSX, { ...SMALL, maxSheetCells: 100 }))).toBe("sheet_cells");
    });
  });

  describe("isolation: a parser that hangs or exhausts memory costs only its thread", () => {
    function workerFile(body: string): URL {
      const dir = mkdtempSync(join(tmpdir(), "aidp-hostile-"));
      const file = join(dir, "worker.mjs");
      writeFileSync(
        file,
        `import { parentPort } from "node:worker_threads";\n${body}\nparentPort.postMessage({ ok: true, value: "done" });\n`,
      );
      return pathToFileURL(file);
    }

    it("terminates a parser that never returns", async () => {
      const started = Date.now();
      const hang = workerFile("while (true) { /* a pathological document */ }");
      const code = await rejection(runInWorker(hang, {}, { timeoutMs: 400, heapMb: 64 }));
      expect(code).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(5000);
      // The process is still here and still answers.
      expect(await runInWorker(workerFile(""), {}, { timeoutMs: 5000, heapMb: 64 })).toBe("done");
    });

    it("kills a parser that outgrows its heap, and the process survives", async () => {
      const hog = workerFile("const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random()));");
      const code = await rejection(runInWorker(hog, {}, { timeoutMs: 20_000, heapMb: 48 }));
      expect(code).toBe("memory");
    });

    it("runs the real extractor in a worker and refuses a hostile file there too", async () => {
      const ok = await extractIsolated(makeDocx("Isolated and fine, as ever."), DOCX, SMALL);
      expect(ok.text).toContain("Isolated and fine");
      expect(await rejection(extractIsolated(makeEntityBombDocx(), DOCX, SMALL))).toBe("xml_doctype");
      expect(await rejection(extractIsolated(makePdf(5000), "application/pdf", SMALL))).toBe("pdf_pages");
    });
  });
});

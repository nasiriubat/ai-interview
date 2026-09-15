import { describe, expect, it } from "vitest";
import {
  extractText,
  isImageMime,
  isTextMime,
  kindForMime,
  normalizeText,
} from "../../src/ingest/extract.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Real files, built here rather than checked in as fixtures, so the test says what is in them and
 * a reader can see why the assertion is what it is. Each one is the smallest document of its
 * format that still exercises the parser.
 */
async function makeXlsx(): Promise<Buffer> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  const ward = wb.addWorksheet("Ward");
  ward.addRow(["Task", "Minutes", "System"]);
  ward.addRow(["Observations", 45, "Patient system"]);
  ward.addRow(["Re-entry", 45, "Excel sheet"]);
  const rota = wb.addWorksheet("Rota");
  rota.addRow(["Week", "Hours"]);
  rota.addRow([1, { formula: "2*3", result: 6 }]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A minimal one-page PDF with a text object, written by hand so no library builds it. */
function makePdf(line: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("mime classification", () => {
  it("sorts the eight accepted types into the three attachment kinds", () => {
    expect(kindForMime("application/pdf")).toBe("document");
    expect(kindForMime("text/csv")).toBe("document");
    expect(kindForMime(XLSX)).toBe("document");
    expect(kindForMime("image/png")).toBe("image");
    expect(kindForMime("image/jpeg")).toBe("image");
    expect(kindForMime("audio/webm")).toBe("audio");
    expect(kindForMime("audio/mp4")).toBe("audio");
  });

  it("refuses a type it cannot place, rather than guessing", () => {
    expect(kindForMime("application/zip")).toBeNull();
    expect(kindForMime("application/x-msdownload")).toBeNull();
    expect(kindForMime("")).toBeNull();
  });

  it("separates the formats read without a model from those needing one", () => {
    expect(isTextMime("application/pdf")).toBe(true);
    expect(isTextMime("image/png")).toBe(false);
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
  });
});

describe("extractText", () => {
  it("reads plain text and markdown", async () => {
    const md = Buffer.from("# Ward notes\n\nObservations are typed twice.\n");

    const out = await extractText(md, "text/markdown");

    expect(out.text).toBe("# Ward notes\n\nObservations are typed twice.");
    expect(out.empty).toBe(false);
  });

  it("drops a byte-order mark, which spreadsheets add to exported CSV", async () => {
    const csv = Buffer.from("﻿Task,Minutes\nObservations,45\n");

    const out = await extractText(csv, "text/csv");

    expect(out.text.startsWith("Task")).toBe(true);
    expect(out.text).toContain("Observations,45");
  });

  it("reports text that parsed to almost nothing, which is how a scan arrives", async () => {
    const out = await extractText(Buffer.from("   \n\n "), "text/plain");

    expect(out.text).toBe("");
    expect(out.empty).toBe(true);
  });

  it("reads a PDF and counts its pages", async () => {
    const out = await extractText(makePdf("Observations are typed twice each shift"), "application/pdf");

    expect(out.text).toContain("Observations are typed twice");
    expect(out.parts).toBe(1);
    expect(out.empty).toBe(false);
  });

  it("reads a workbook as one line per row, with a heading per sheet", async () => {
    const out = await extractText(await makeXlsx(), XLSX);

    expect(out.text).toContain("## Ward");
    expect(out.text).toContain("## Rota");
    expect(out.text).toContain("Observations\t45\tPatient system");
    expect(out.parts).toBe(2);
  });

  it("renders a formula cell as its computed result, which is what a reader sees", async () => {
    const out = await extractText(await makeXlsx(), XLSX);

    expect(out.text).toContain("1\t6");
    expect(out.text).not.toContain("2*3");
  });

  it("refuses a format it has no extractor for", async () => {
    await expect(extractText(Buffer.from("x"), "application/zip")).rejects.toThrow(/No text extractor/);
  });

  it("does not throw on bytes that are not valid UTF-8", async () => {
    const out = await extractText(Buffer.from([0xff, 0xfe, 0x41, 0x42, 0x43]), "text/plain");

    expect(typeof out.text).toBe("string");
  });

  it("refuses a DOCX that is not one, rather than returning nonsense", async () => {
    await expect(extractText(Buffer.from("not a docx at all"), DOCX)).rejects.toThrow();
  });
});

describe("normalizeText", () => {
  it("collapses whitespace runs but keeps paragraph breaks", () => {
    expect(normalizeText("a   b\r\n\r\n\r\n\r\nc   \n   d")).toBe("a b\n\nc\nd");
  });

  it("keeps a column boundary, because in a spreadsheet the boundary is the meaning", () => {
    // A run that contains a tab collapses to a tab, not a space: otherwise
    // "Observations<TAB>45<TAB>Patient system" stops saying which number belongs to which heading.
    expect(normalizeText("a  \t b")).toBe("a\tb");
    expect(normalizeText("Observations\t\t45")).toBe("Observations\t45");
  });

  it("folds non-breaking spaces in with ordinary ones", () => {
    // They arrive constantly from PDFs and from anything pasted out of Word, and left alone they
    // defeat every later split on whitespace.
    expect(normalizeText("a  b")).toBe("a b");
    expect(normalizeText("a \tb")).toBe("a\tb");
  });

  it("is idempotent", () => {
    for (const input of ["a  b\r\n\r\n\r\nc", "x\t\ty", "p q"]) {
      const once = normalizeText(input);
      expect(normalizeText(once)).toBe(once);
    }
  });
});

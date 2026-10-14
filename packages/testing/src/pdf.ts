import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfSummary {
  /** The text of each page, lines joined with newlines. */
  pages: string[];
  /** Every page's text, joined. */
  text: string;
  title: string | undefined;
  author: string | undefined;
  /** Top-level outline entries, when the document carries any. */
  outline: string[];
  /** Number of embedded raster images, per page. */
  imagesPerPage: number[];
}

/**
 * Reads a generated PDF back the way a reader would: its text per page and its metadata. Used by the
 * export tests so they assert on what a person opening the file sees, not on the bytes written.
 */
export async function readPdf(bytes: Uint8Array): Promise<PdfSummary> {
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    const imagesPerPage: number[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      pages.push(
        text
          .replace(/[ \t]+/g, " ")
          .replace(/ \n/g, "\n")
          .trim(),
      );
      const ops = await page.getOperatorList();
      // OPS.paintImageXObject is 85 in pdf.js; counted by value so the helper needs no private import.
      imagesPerPage.push(ops.fnArray.filter((f) => f === 85).length);
    }
    const meta = await doc.getMetadata();
    const info = meta.info as Record<string, unknown>;
    // pdf.js answers null for a document with no outline, whatever its types say.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const outline = (await doc.getOutline()) ?? [];
    return {
      pages,
      text: pages.join("\n"),
      title: typeof info.Title === "string" ? info.Title : undefined,
      author: typeof info.Author === "string" ? info.Author : undefined,
      outline: outline.map((o) => o.title),
      imagesPerPage,
    };
  } finally {
    await task.destroy();
  }
}

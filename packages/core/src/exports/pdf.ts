import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { KrokiSyntaxError, KrokiUnavailableError, withExportTheme, type KrokiPort } from "./kroki.js";
import {
  buildBody,
  cleanText,
  codeBlock,
  DEFAULT_MARKDOWN_LIMITS,
  MONO,
  tint,
  type DiagramSlot,
  type MarkdownLimits,
} from "./markdown-to-doc.js";

/*
 * The PDF composer (D-210): Markdown in, a PDF out, in this process, with no browser.
 *
 * pdfmake lays the document out and PDFKit writes it; the only network call is to the diagram
 * renderer, through the port, and a diagram the renderer cannot or does not draw becomes its source
 * in a code block with a note, so the document is always complete. Page size, cover, footer text and
 * accent colour are the caller's (they come from settings); every other dimension is capped here.
 */

export interface PdfBrand {
  productName: string;
  /** `#rrggbb`; anything else falls back to the default. */
  color: string;
  footerText: string;
  pageSize: "A4" | "Letter";
  cover: boolean;
}

export interface PdfLimits extends MarkdownLimits {
  /** A document longer than this is refused, not cut. */
  maxPages: number;
  /** Time the whole set of diagrams may take; later ones degrade to source. */
  diagramBudgetMs: number;
  diagramConcurrency: number;
  /** Largest PDF handed back. */
  maxBytes: number;
}

export const DEFAULT_PDF_LIMITS: PdfLimits = {
  ...DEFAULT_MARKDOWN_LIMITS,
  maxPages: 150,
  diagramBudgetMs: 45_000,
  diagramConcurrency: 3,
  maxBytes: 20 * 1024 * 1024,
};

export interface PdfInput {
  /** Document title for the cover, header and metadata. Falls back to the first heading. */
  title: string;
  markdown: string;
  /** `en` or `fi`; anything else is English. Chooses the fixed strings (contents, page, notes). */
  language: string;
  /** Short label for the footer and cover, such as `Version 3` or `Report 2`. */
  versionLabel: string;
  date: Date;
  brand: PdfBrand;
  /** Absent when no renderer is configured: every diagram is then shown as source. */
  kroki: KrokiPort | null;
  limits?: Partial<PdfLimits>;
}

export interface PdfResult {
  bytes: Buffer;
  pages: number;
  /** Machine-readable notes: `diagram_unrendered:<n>`, `diagram_syntax:<n>`, `truncated:blocks`, ... */
  warnings: string[];
  diagrams: { total: number; rendered: number };
}

export class PdfTooLargeError extends Error {
  constructor(
    readonly reason: "pages" | "bytes",
    readonly limit: number,
  ) {
    super(
      reason === "pages"
        ? `The document is longer than ${limit} pages`
        : `The document is larger than ${Math.round(limit / 1024 / 1024)} MB`,
    );
    this.name = "PdfTooLargeError";
  }
}

const LABELS = {
  en: {
    contents: "Contents",
    page: (n: number, total: number) => `Page ${n} of ${total}`,
    generated: (d: string) => `Generated ${d}`,
    unrendered: "This diagram could not be drawn; its source is shown instead.",
    syntax: "This diagram has an error and could not be drawn; its source is shown instead.",
    untitled: "Untitled",
  },
  fi: {
    contents: "Sisällys",
    page: (n: number, total: number) => `Sivu ${n} / ${total}`,
    generated: (d: string) => `Luotu ${d}`,
    unrendered: "Kaaviota ei voitu piirtää, joten sen lähdekoodi näytetään.",
    syntax: "Kaaviossa on virhe, eikä sitä voitu piirtää, joten sen lähdekoodi näytetään.",
    untitled: "Nimetön",
  },
} as const;

const DEFAULT_COLOR = "#1f4e79";
const MARGIN = 40;
const PAGE = { A4: { width: 595.28, height: 841.89 }, Letter: { width: 612, height: 792 } } as const;

// ---------- fonts ----------

interface PdfMakeModule {
  virtualfs: { writeFileSync(name: string, data: Buffer): void };
  setFonts(fonts: Record<string, Record<string, string>>): void;
  setUrlAccessPolicy(fn: (url: string) => boolean): void;
  setLocalAccessPolicy(fn: (path: string) => boolean): void;
  createPdf(def: unknown): { getBuffer(): Promise<Buffer> };
}

let engine: PdfMakeModule | undefined;

/**
 * The pdfmake singleton with its fonts in its virtual file system. Local files and URLs are both
 * refused by policy: the document definition is built from tenant text, and nothing in it may
 * name a file or an address to read.
 */
function pdfmake(): PdfMakeModule {
  if (engine) return engine;
  const require = createRequire(import.meta.url);
  const lib = require("pdfmake") as PdfMakeModule;
  const roboto = (name: string): string => require.resolve(`pdfmake/fonts/Roboto/${name}`);
  const mono = (name: string): string => require.resolve(`@fontsource/roboto-mono/files/${name}`);
  const files: [string, string][] = [
    ["Roboto-Regular.ttf", roboto("Roboto-Regular.ttf")],
    ["Roboto-Medium.ttf", roboto("Roboto-Medium.ttf")],
    ["Roboto-Italic.ttf", roboto("Roboto-Italic.ttf")],
    ["Roboto-MediumItalic.ttf", roboto("Roboto-MediumItalic.ttf")],
    ["RobotoMono-Regular.woff", mono("roboto-mono-latin-400-normal.woff")],
    ["RobotoMono-Bold.woff", mono("roboto-mono-latin-700-normal.woff")],
  ];
  for (const [name, path] of files) lib.virtualfs.writeFileSync(name, readFileSync(path));
  lib.setFonts({
    Roboto: {
      normal: "Roboto-Regular.ttf",
      bold: "Roboto-Medium.ttf",
      italics: "Roboto-Italic.ttf",
      bolditalics: "Roboto-MediumItalic.ttf",
    },
    [MONO]: {
      normal: "RobotoMono-Regular.woff",
      bold: "RobotoMono-Bold.woff",
      italics: "RobotoMono-Regular.woff",
      bolditalics: "RobotoMono-Bold.woff",
    },
  });
  lib.setLocalAccessPolicy(() => false);
  lib.setUrlAccessPolicy(() => false);
  engine = lib;
  return lib;
}

// ---------- diagrams ----------

interface PngSize {
  width: number;
  height: number;
}

/** Dimensions from the IHDR chunk; null for anything that is not a PNG with a size. */
function pngSize(png: Buffer): PngSize | null {
  if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

/** A drawing beyond this is a layout gone wrong (D-320): unreadable on a page however it is scaled. */
const isOversized = (s: PngSize): boolean => s.width > 8_000 || s.height > 12_000;

async function renderDiagrams(
  slots: DiagramSlot[],
  kroki: KrokiPort | null,
  limits: PdfLimits,
  warnings: string[],
): Promise<Map<number, { png: Buffer; size: PngSize }>> {
  const done = new Map<number, { png: Buffer; size: PngSize }>();
  if (slots.length === 0) return done;
  if (!kroki) {
    for (const s of slots) warnings.push(`diagram_unrendered:${s.index + 1}`);
    return done;
  }
  const deadline = Date.now() + limits.diagramBudgetMs;
  let down = false;
  const queue = [...slots];
  const worker = async (): Promise<void> => {
    for (let slot = queue.shift(); slot; slot = queue.shift()) {
      const n = slot.index + 1;
      if (down || Date.now() >= deadline) {
        warnings.push(`diagram_unrendered:${n}`);
        continue;
      }
      try {
        const png = await kroki.render(withExportTheme(slot.source), "png");
        const size = pngSize(png);
        if (!size) throw new KrokiUnavailableError("The renderer returned an unusable image");
        if (isOversized(size)) {
          // This one diagram is the problem, not the service: the others are still asked for. It
          // used to be treated as "the renderer is down", which sent every later diagram to
          // source as well (D-320).
          warnings.push(`diagram_too_large:${n}`);
          continue;
        }
        done.set(slot.index, { png, size });
      } catch (e) {
        if (e instanceof KrokiSyntaxError) warnings.push(`diagram_syntax:${n}`);
        else {
          // One failure to reach the renderer is the answer for the rest: not N more timeouts.
          down = true;
          warnings.push(`diagram_unrendered:${n}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.diagramConcurrency, slots.length) }, worker));
  return done;
}

// ---------- the document ----------

const validColor = (c: string): string => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : DEFAULT_COLOR);

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export async function renderPdf(input: PdfInput): Promise<PdfResult> {
  const limits: PdfLimits = { ...DEFAULT_PDF_LIMITS, ...input.limits };
  const lang = input.language.toLowerCase().startsWith("fi") ? "fi" : "en";
  const L = LABELS[lang];
  const color = validColor(input.brand.color);
  const theme = { color };
  const body = buildBody(input.markdown, theme, limits);
  const warnings = [...body.warnings];
  const wanted = input.title.trim() === "" ? (body.title ?? "") : input.title;
  const title = cleanText(wanted).trim() || L.untitled;
  const productName = cleanText(input.brand.productName).trim().slice(0, 80);
  const footerText = cleanText(input.brand.footerText).trim().slice(0, 120);
  const date = isoDate(input.date);
  const size = input.brand.pageSize === "Letter" ? PAGE.Letter : PAGE.A4;
  const contentWidth = size.width - MARGIN * 2;

  const rendered = await renderDiagrams(body.diagrams, input.kroki, limits, warnings);
  const images: Record<string, string> = {};
  for (const slot of body.diagrams) {
    const hit = rendered.get(slot.index);
    if (hit) {
      // 96 dpi pixels to points, never larger than the text block, never taller than most of a page.
      const natural = hit.size.width * 0.75;
      const scale = Math.min(1, contentWidth / natural, 440 / (hit.size.height * 0.75));
      const name = `diagram-${slot.index}`;
      images[name] = `data:image/png;base64,${hit.png.toString("base64")}`;
      slot.node.stack.push({
        image: name,
        width: natural * scale,
        alignment: "center",
        margin: [0, 2, 0, 8],
      });
    } else {
      const kind = warnings.includes(`diagram_syntax:${slot.index + 1}`) ? L.syntax : L.unrendered;
      slot.node.stack.push(
        { text: kind, italics: true, color: "#6b6b6b", fontSize: 8.5, margin: [0, 0, 0, 3] },
        codeBlock(slot.source, theme),
      );
    }
  }

  const tocItems = body.content.filter((n) => (n as { tocItem?: boolean }).tocItem === true).length;
  const front: unknown[] = [];
  if (input.brand.cover) {
    front.push(
      {
        canvas: [{ type: "rect", x: 0, y: 0, w: contentWidth, h: 6, color }],
        margin: [0, 150, 0, 24],
      },
      { text: productName, fontSize: 13, color, bold: true, margin: [0, 0, 0, 10] },
      { text: title, fontSize: 28, bold: true, lineHeight: 1.1, margin: [0, 0, 0, 14] },
      { text: input.versionLabel, fontSize: 13, color: "#444444", margin: [0, 0, 0, 4] },
      { text: L.generated(date), fontSize: 11, color: "#666666" },
      { text: "", pageBreak: "after" },
    );
  } else {
    front.push({ text: title, fontSize: 22, bold: true, color, margin: [0, 0, 0, 4] });
    front.push({
      text: `${productName ? `${productName} · ` : ""}${input.versionLabel} · ${L.generated(date)}`,
      fontSize: 9.5,
      color: "#666666",
      margin: [0, 0, 0, 12],
    });
  }
  if (tocItems >= 2) {
    front.push({
      toc: { title: { text: L.contents, fontSize: 15, bold: true, color, margin: [0, 0, 0, 6] } },
      margin: [0, 0, 0, 12],
    });
  }

  const footerLeft = [productName, title, input.versionLabel].filter(Boolean).join(" · ");
  const definition = {
    info: {
      title,
      author: productName || undefined,
      subject: input.versionLabel,
      creator: productName || "AI Discovery Platform",
      producer: "pdfmake",
    },
    language: lang,
    displayTitle: true,
    pageSize: { width: size.width, height: size.height },
    pageMargins: [MARGIN, 56, MARGIN, 52],
    maxPagesNumber: limits.maxPages + 1,
    content: [...front, ...body.content],
    images,
    defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.2 },
    header: (page: number) =>
      input.brand.cover && page === 1
        ? null
        : {
            columns: [
              { text: title, color: "#888888", fontSize: 8, width: "*", noWrap: true },
              { text: date, color: "#888888", fontSize: 8, alignment: "right", width: "auto" },
            ],
            margin: [MARGIN, 24, MARGIN, 0],
          },
    footer: (page: number, pages: number) =>
      input.brand.cover && page === 1
        ? null
        : {
            stack: [
              {
                canvas: [
                  {
                    type: "line",
                    x1: 0,
                    y1: 0,
                    x2: contentWidth,
                    y2: 0,
                    lineWidth: 0.6,
                    lineColor: tint(color),
                  },
                ],
              },
              {
                columns: [
                  { text: footerLeft, fontSize: 8, color: "#666666", width: "*", noWrap: true },
                  {
                    text: L.page(page, pages),
                    fontSize: 8,
                    color: "#666666",
                    alignment: "right",
                    width: "auto",
                  },
                ],
                margin: [0, 4, 0, 0],
              },
              ...(footerText
                ? [{ text: footerText, fontSize: 7.5, color: "#888888", margin: [0, 2, 0, 0] }]
                : []),
            ],
            margin: [MARGIN, 18, MARGIN, 0],
          },
  };

  const bytes = await pdfmake().createPdf(definition).getBuffer();
  const pages = countPages(bytes);
  if (pages > limits.maxPages) throw new PdfTooLargeError("pages", limits.maxPages);
  if (bytes.length > limits.maxBytes) throw new PdfTooLargeError("bytes", limits.maxBytes);
  return {
    bytes,
    pages,
    warnings,
    diagrams: { total: body.diagrams.length, rendered: rendered.size },
  };
}

/** PDFKit writes each page dictionary uncompressed, so `/Type /Page` (not `/Pages`) counts them. */
export function countPages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type \/Page(?![A-Za-z])/g) ?? []).length;
}

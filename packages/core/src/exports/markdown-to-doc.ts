import MarkdownIt, { type Token } from "markdown-it";

/*
 * Markdown to a pdfmake document body (D-210).
 *
 * The grammar is a constrained one on purpose: exactly what `renderReport` and
 * `renderSpecMarkdown` emit (headings, paragraphs, lists, tables, quotes, fenced code, Mermaid
 * fences, rules), read from participant-derived text. HTML is not parsed (markdown-it runs with
 * `html: false`, so a tag is text), images and links are never fetched (an image becomes its alt
 * text, a link becomes its text and its address in brackets), and every dimension that a hostile
 * input could blow up is capped: characters, blocks, nesting depth, table size.
 */

export interface MarkdownLimits {
  /** Characters of Markdown read; the rest is dropped with a warning. */
  maxChars: number;
  /** Top-level plus nested blocks emitted. */
  maxBlocks: number;
  maxNesting: number;
  maxTableColumns: number;
  maxTableRows: number;
  /** Mermaid fences found; later ones are shown as source. */
  maxDiagrams: number;
  /** Largest single Mermaid fence, in characters. */
  maxDiagramChars: number;
}

export const DEFAULT_MARKDOWN_LIMITS: MarkdownLimits = {
  maxChars: 400_000,
  maxBlocks: 6_000,
  maxNesting: 5,
  maxTableColumns: 8,
  maxTableRows: 400,
  maxDiagrams: 12,
  maxDiagramChars: 20_000,
};

export interface PdfTheme {
  /** `#rrggbb` accent for headings and table rules. */
  color: string;
}

/** A diagram the document asks for: the caller renders it and fills `slot.stack`. */
export interface DiagramSlot {
  index: number;
  source: string;
  /** Text above the fence in the source: its title, when the Markdown gave one. */
  title: string;
  /** Filled in by the caller; the node is already in the document. */
  node: { stack: unknown[] };
}

export interface BuiltBody {
  content: unknown[];
  diagrams: DiagramSlot[];
  /** First level-1 heading, which the cover carries instead of the body. */
  title: string | undefined;
  warnings: string[];
}

export const MONO = "RobotoMono";

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });

// Text a reader cannot see but a layout engine may mishandle: C0/C1 controls, zero-width and bidi
// override characters (the latter reorder text to make it read as something it is not).
const INVISIBLE = new RegExp(
  [
    "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f",
    "\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff\\ufffd]",
  ].join(""),
  "g",
);

export function cleanText(s: string): string {
  return s.normalize("NFC").replace(INVISIBLE, "");
}

const safeHref = (href: string): string | null => {
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:"
      ? cleanText(href).slice(0, 300)
      : null;
  } catch {
    return null;
  }
};

interface Style {
  bold?: boolean;
  italics?: boolean;
  decoration?: "lineThrough";
  code?: boolean;
}

/** Inline tokens to pdfmake text parts. */
function inline(tokens: Token[] | null | undefined, theme: PdfTheme): unknown[] {
  const out: unknown[] = [];
  const style: Style = {};
  const hrefs: (string | null)[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text":
        push(out, t.content, style, theme);
        break;
      case "code_inline":
        push(out, t.content, { ...style, code: true }, theme);
        break;
      case "softbreak":
        out.push({ text: " " });
        break;
      case "hardbreak":
        out.push({ text: "\n" });
        break;
      case "strong_open":
        style.bold = true;
        break;
      case "strong_close":
        style.bold = false;
        break;
      case "em_open":
        style.italics = true;
        break;
      case "em_close":
        style.italics = false;
        break;
      case "s_open":
        style.decoration = "lineThrough";
        break;
      case "s_close":
        delete style.decoration;
        break;
      case "link_open":
        hrefs.push(safeHref(String(t.attrGet("href") ?? "")));
        break;
      case "link_close": {
        const href = hrefs.pop();
        // The address is shown, not followed: a PDF that opens links is a PDF that can be made to
        // look like it says one thing and go somewhere else.
        if (href) out.push({ text: ` (${href})`, color: "#555555", fontSize: 8.5 });
        break;
      }
      case "image":
        // No fetch, ever: the alt text is what the document keeps.
        push(out, `[${t.content || "image"}]`, { ...style, italics: true }, theme);
        break;
      default:
        if (t.content) push(out, t.content, style, theme);
    }
  }
  return out;
}

function push(out: unknown[], text: string, style: Style, theme: PdfTheme): void {
  const t = cleanText(text);
  if (!t) return;
  const node: Record<string, unknown> = { text: t };
  if (style.bold) node.bold = true;
  if (style.italics) node.italics = true;
  if (style.decoration) node.decoration = style.decoration;
  if (style.code) {
    node.font = MONO;
    node.fontSize = 9;
    node.background = "#eef0f3";
    node.color = theme.color;
  }
  out.push(node);
}

const HEADING_SIZES: Record<number, number> = { 1: 20, 2: 15, 3: 12.5, 4: 11, 5: 10, 6: 10 };

/** Builds the document body from Markdown. Pure: nothing is fetched or rendered here. */
export function buildBody(
  markdown: string,
  theme: PdfTheme,
  limits: MarkdownLimits = DEFAULT_MARKDOWN_LIMITS,
): BuiltBody {
  const warnings: string[] = [];
  let source = markdown.replace(/\r\n?/g, "\n");
  if (source.length > limits.maxChars) {
    source = source.slice(0, limits.maxChars);
    warnings.push("truncated:characters");
  }
  const tokens = md.parse(source, {});
  const diagrams: DiagramSlot[] = [];
  let blocks = 0;
  let title: string | undefined;
  let capped = false;
  let lastHeading = "";

  /** Index of the token that closes the one opened at `i`. */
  const closeOf = (i: number): number => {
    let depth = 0;
    for (let j = i; j < tokens.length; j++) {
      const t = tokens[j];
      if (!t) break;
      depth += t.nesting;
      if (depth === 0) return j;
    }
    return tokens.length - 1;
  };

  const walk = (from: number, to: number, depth: number): unknown[] => {
    const out: unknown[] = [];
    let i = from;
    while (i < to) {
      const t = tokens[i];
      if (!t) break;
      if (blocks >= limits.maxBlocks) {
        if (!capped) warnings.push("truncated:blocks");
        capped = true;
        break;
      }
      switch (t.type) {
        case "heading_open": {
          const level = Number(t.tag.slice(1));
          const body = inline(tokens[i + 1]?.children, theme);
          const text = cleanText(tokens[i + 1]?.content ?? "");
          if (level === 1 && title === undefined && out.length === 0 && depth === 0) {
            title = text;
          } else {
            blocks++;
            lastHeading = text;
            out.push({
              text: body.length ? body : text,
              fontSize: HEADING_SIZES[level] ?? 10,
              bold: true,
              color: level <= 3 ? theme.color : "#222222",
              margin: [0, level <= 2 ? 14 : 9, 0, 4],
              ...(level <= 3 ? { tocItem: level <= 2, tocMargin: [level === 2 ? 0 : 12, 0, 0, 0] } : {}),
              ...(level <= 2 ? { headlineLevel: level } : {}),
            });
          }
          i = closeOf(i) + 1;
          break;
        }
        case "paragraph_open": {
          blocks++;
          const body = inline(tokens[i + 1]?.children, theme);
          if (body.length) out.push({ text: body, margin: [0, 0, 0, 6], lineHeight: 1.2 });
          i = closeOf(i) + 1;
          break;
        }
        case "bullet_list_open":
        case "ordered_list_open": {
          const end = closeOf(i);
          blocks++;
          const items: unknown[] = [];
          let j = i + 1;
          while (j < end) {
            const itemEnd = closeOf(j);
            items.push({ stack: walk(j + 1, itemEnd, depth + 1), margin: [0, 0, 0, 2] });
            j = itemEnd + 1;
          }
          // Past the nesting cap a list is flattened into its parent's items rather than dropped.
          if (depth >= limits.maxNesting) {
            out.push(...items);
            i = end + 1;
            break;
          }
          const ordered = t.type === "ordered_list_open";
          const start = Number(t.attrGet("start") ?? 1);
          out.push({
            ...(ordered ? { ol: items, start: Number.isFinite(start) ? start : 1 } : { ul: items }),
            margin: [depth === 0 ? 4 : 0, 0, 0, 6],
          });
          i = end + 1;
          break;
        }
        case "blockquote_open": {
          const end = closeOf(i);
          blocks++;
          const inner = walk(i + 1, end, depth + 1);
          if (depth >= limits.maxNesting) {
            out.push(...inner);
            i = end + 1;
            break;
          }
          out.push({
            table: { widths: ["*"], body: [[{ stack: inner, margin: [8, 2, 4, 2] }]] },
            layout: {
              hLineWidth: () => 0,
              vLineWidth: (k: number) => (k === 0 ? 2.5 : 0),
              vLineColor: () => theme.color,
              paddingLeft: () => 0,
            },
            margin: [0, 0, 0, 8],
            color: "#444444",
          });
          i = end + 1;
          break;
        }
        case "fence":
        case "code_block": {
          blocks++;
          const info = t.type === "fence" ? t.info.trim().split(/\s+/)[0]?.toLowerCase() : "";
          const code = cleanText(t.content).replace(/\n$/, "");
          if (info === "mermaid") {
            const slot: DiagramSlot = {
              index: diagrams.length,
              source: code,
              title: lastHeading,
              node: { stack: [] },
            };
            if (
              diagrams.length < limits.maxDiagrams &&
              code.length <= limits.maxDiagramChars &&
              code.trim() !== ""
            ) {
              diagrams.push(slot);
              out.push(slot.node);
            } else {
              // Past the caps the source is shown as it is, like any other code.
              if (diagrams.length >= limits.maxDiagrams) warnings.push("diagram_over_limit");
              else warnings.push("diagram_too_large");
              out.push(codeBlock(code, theme));
            }
          } else {
            out.push(codeBlock(code, theme));
          }
          i++;
          break;
        }
        case "hr":
          blocks++;
          out.push({
            canvas: [{ type: "line", x1: 0, y1: 2, x2: 515, y2: 2, lineWidth: 0.7, lineColor: "#bbbbbb" }],
            margin: [0, 6, 0, 8],
          });
          i++;
          break;
        case "table_open": {
          const end = closeOf(i);
          blocks++;
          out.push(table(tokens.slice(i, end + 1), theme, limits, warnings));
          i = end + 1;
          break;
        }
        default:
          // Anything the grammar does not name (a stray html_block, a footnote) is skipped, never
          // interpreted.
          i = t.nesting === 1 ? closeOf(i) + 1 : i + 1;
      }
    }
    return out;
  };

  const content = walk(0, tokens.length, 0);
  return { content, diagrams, title, warnings };
}

export function codeBlock(code: string, theme: PdfTheme): unknown {
  return {
    table: {
      widths: ["*"],
      body: [
        [
          {
            text: code || " ",
            font: MONO,
            fontSize: 8.5,
            preserveLeadingSpaces: true,
            lineHeight: 1.15,
            margin: [6, 5, 6, 5],
          },
        ],
      ],
    },
    layout: {
      fillColor: () => "#f4f5f7",
      hLineWidth: () => 0,
      vLineWidth: (k: number) => (k === 0 ? 2 : 0),
      vLineColor: () => theme.color,
    },
    margin: [0, 0, 0, 8],
  };
}

function table(tokens: Token[], theme: PdfTheme, limits: MarkdownLimits, warnings: string[]): unknown {
  const rows: { cells: unknown[]; head: boolean }[] = [];
  let row: { cells: unknown[]; head: boolean } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.type === "tr_open") row = { cells: [], head: false };
    else if (t.type === "tr_close" && row) {
      rows.push(row);
      row = null;
    } else if ((t.type === "th_open" || t.type === "td_open") && row) {
      const head = t.type === "th_open";
      row.head = row.head || head;
      const body = inline(tokens[i + 1]?.children, theme);
      row.cells.push({
        text: body.length ? body : " ",
        bold: head,
        fontSize: 9,
        margin: [2, 2, 2, 2],
        ...(head ? { fillColor: tint(theme.color) } : {}),
      });
    }
  }
  const width = Math.min(limits.maxTableColumns, Math.max(1, ...rows.map((r) => r.cells.length)));
  if (rows.some((r) => r.cells.length > width)) warnings.push("table_columns_truncated");
  if (rows.length > limits.maxTableRows) warnings.push("table_rows_truncated");
  const body = rows.slice(0, limits.maxTableRows).map((r) => {
    const cells = r.cells.slice(0, width);
    while (cells.length < width) cells.push({ text: " " });
    return cells;
  });
  return {
    table: { headerRows: rows[0]?.head ? 1 : 0, widths: Array<string>(width).fill("*"), body },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0,
      hLineColor: () => "#cccccc",
    },
    margin: [0, 0, 0, 8],
  };
}

/** A pale version of the accent colour, for table header fills. */
export function tint(color: string): string {
  const n = Number.parseInt(color.slice(1), 16);
  const mix = (c: number): number => Math.round(c + (255 - c) * 0.88);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

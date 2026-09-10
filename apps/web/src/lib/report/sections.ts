import { REPORT_SECTIONS, type ReportSection } from "@aidp/shared";

/*
 * Section toggles need to know where each report section starts in the Markdown. The
 * contract does not mark sections, so two strategies apply (README, contract gaps):
 * 1. `<!-- section: key -->` comment markers, when the API emits them.
 * 2. Otherwise the n-th level-2 heading (`## `) outside code fences is taken to be the
 *    n-th entry of `report.sections`.
 * Content before the first section (title, intro) is always shown.
 */

export interface ReportChunk {
  /** `null` for the preamble and for headings the section list does not cover. */
  key: ReportSection | null;
  markdown: string;
}

const MARKER_RE = /^\s*<!--\s*section:\s*([a-z_]+)\s*-->\s*$/;
const H2_RE = /^##\s+\S/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

export function isReportSection(value: unknown): value is ReportSection {
  return typeof value === "string" && (REPORT_SECTIONS as readonly string[]).includes(value);
}

export function splitReportSections(markdown: string, sections: readonly string[]): ReportChunk[] {
  const lines = markdown.split(/\r?\n/);
  const known = sections.filter(isReportSection);
  const hasMarkers = lines.some((l) => MARKER_RE.test(l));
  const chunks: ReportChunk[] = [];
  let current: ReportChunk = { key: null, markdown: "" };
  let buffer: string[] = [];
  let headingIndex = 0;
  let fence: string | null = null;

  const push = (): void => {
    current.markdown = buffer.join("\n");
    if (current.markdown.trim() || current.key !== null) chunks.push(current);
    buffer = [];
  };

  for (const line of lines) {
    const f = FENCE_RE.exec(line);
    if (f?.[1]) {
      if (fence === null) fence = f[1];
      else if (f[1].startsWith(fence.charAt(0)) && f[1].length >= fence.length) fence = null;
      buffer.push(line);
      continue;
    }
    if (fence !== null) {
      buffer.push(line);
      continue;
    }
    if (hasMarkers) {
      const m = MARKER_RE.exec(line);
      if (m) {
        push();
        current = { key: isReportSection(m[1]) ? m[1] : null, markdown: "" };
        continue; // the marker itself is not rendered
      }
      buffer.push(line);
      continue;
    }
    if (H2_RE.test(line)) {
      push();
      current = { key: known[headingIndex] ?? null, markdown: "" };
      headingIndex++;
    }
    buffer.push(line);
  }
  push();
  return chunks;
}

/** Joins the chunks whose section is enabled (preamble and unkeyed chunks always). */
export function visibleMarkdown(chunks: readonly ReportChunk[], enabled: ReadonlySet<string>): string {
  return chunks
    .filter((c) => c.key === null || enabled.has(c.key))
    .map((c) => c.markdown)
    .join("\n")
    .trim();
}

/** Reads `analysis.reportSections` from a settings value, falling back to every section. */
export function parseReportSections(raw: unknown): ReportSection[] {
  if (!Array.isArray(raw)) return [...REPORT_SECTIONS];
  return raw.filter(isReportSection);
}

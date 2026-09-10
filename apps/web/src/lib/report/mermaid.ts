/*
 * Splits report Markdown into plain Markdown segments and Mermaid diagrams. The report
 * renderer feeds the former to react-markdown and the latter to the client-side Mermaid
 * component, so diagrams never go through the Markdown pipeline as code blocks.
 */

export type MarkdownSegment = { kind: "markdown"; text: string } | { kind: "mermaid"; code: string };

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;

/**
 * Finds ```mermaid fences (also `~~~mermaid`), including unterminated ones at the end of
 * the document. Fences of other languages are passed through untouched, and a mermaid
 * fence nested inside another fenced block stays part of that block.
 */
export function extractMermaidBlocks(markdown: string): MarkdownSegment[] {
  const lines = markdown.split(/\r?\n/);
  const out: MarkdownSegment[] = [];
  let buffer: string[] = [];
  let open: { char: string; length: number; mermaid: boolean; code: string[] } | null = null;

  const flushMarkdown = (): void => {
    const text = buffer.join("\n");
    if (text.trim()) out.push({ kind: "markdown", text });
    buffer = [];
  };

  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (open) {
      const closes =
        m?.[2] !== undefined && m[2].startsWith(open.char) && m[2].length >= open.length && !m[3];
      if (closes) {
        if (open.mermaid) {
          out.push({ kind: "mermaid", code: open.code.join("\n").trim() });
        } else {
          buffer.push(...open.code, line);
        }
        open = null;
      } else {
        open.code.push(line);
      }
      continue;
    }
    if (m?.[2] !== undefined) {
      const info = (m[3] ?? "").toLowerCase();
      const mermaid = info === "mermaid";
      if (mermaid) flushMarkdown();
      open = { char: m[2].charAt(0), length: m[2].length, mermaid, code: mermaid ? [] : [line] };
      continue;
    }
    buffer.push(line);
  }

  if (open) {
    if (open.mermaid) out.push({ kind: "mermaid", code: open.code.join("\n").trim() });
    else buffer.push(...open.code);
  }
  flushMarkdown();
  return out;
}

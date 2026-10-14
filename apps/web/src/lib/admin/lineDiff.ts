import type { DiffLine } from "@aidp/shared";

/** Above this many lines on either side the texts are compared as one block, as the server does. */
const MAX_LINES = 2000;

/**
 * Line diff by longest common subsequence, for text the browser already has (a prompt being
 * written against the built-in one). The identical start and end are trimmed first, so a one-line
 * edit to a 150-line prompt costs one small table.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ type: "same", text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ type: "same", text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length > MAX_LINES || y.length > MAX_LINES) {
    return [
      ...head,
      ...x.map((text): DiffLine => ({ type: "del", text })),
      ...y.map((text): DiffLine => ({ type: "add", text })),
      ...tail,
    ];
  }
  const width = y.length + 1;
  const lcs = new Uint16Array((x.length + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      lcs[i * width + j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      mid.push({ type: "same", text: x[i] ?? "" });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      mid.push({ type: "del", text: x[i++] ?? "" });
    } else {
      mid.push({ type: "add", text: y[j++] ?? "" });
    }
  }
  while (i < x.length) mid.push({ type: "del", text: x[i++] ?? "" });
  while (j < y.length) mid.push({ type: "add", text: y[j++] ?? "" });
  return [...head, ...mid, ...tail];
}

export type FoldedLine = DiffLine | { type: "fold"; count: number };

/** Long unchanged stretches become one "n unchanged lines" row, keeping `context` lines around changes. */
export function foldUnchanged(lines: DiffLine[], context = 2): FoldedLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: FoldedLine[] = [];
  let run = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (run > 0) out.push({ type: "fold", count: run });
      run = 0;
      out.push(l);
    } else {
      run++;
    }
  });
  if (run > 0) out.push({ type: "fold", count: run });
  return out;
}

export const countChanges = (lines: DiffLine[]): { added: number; removed: number } => ({
  added: lines.filter((l) => l.type === "add").length,
  removed: lines.filter((l) => l.type === "del").length,
});

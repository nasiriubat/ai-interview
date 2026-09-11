import type { DiffLine, SpecDiff, SpecDocument, SpecRequirement } from "@aidp/shared";

const MAX_LINES = 2000;

/** Line diff by longest common subsequence. Inputs beyond the cap are compared as a single block. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    if (before === after) return a.map((text) => ({ type: "same", text }));
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]; a flat array avoids per-row allocation.
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  const at = (i: number, j: number): number => lcs[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const x = a[i] ?? "";
    const y = b[j] ?? "";
    if (x === y) {
      out.push({ type: "same", text: x });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ type: "del", text: x });
      i++;
    } else {
      out.push({ type: "add", text: y });
      j++;
    }
  }
  for (; i < n; i++) out.push({ type: "del", text: a[i] ?? "" });
  for (; j < m; j++) out.push({ type: "add", text: b[j] ?? "" });
  return out;
}

const sameRequirement = (x: SpecRequirement, y: SpecRequirement): boolean =>
  x.title === y.title &&
  x.scope === y.scope &&
  x.acceptance.join("\n") === y.acceptance.join("\n") &&
  (x.reason ?? "") === (y.reason ?? "");

/** Section-level and requirement-level differences between two versions (FR-26). */
export function diffSpecs(before: SpecDocument, after: SpecDocument): SpecDiff {
  const sections: SpecDiff["sections"] = [];
  const beforeByKey = new Map(before.sections.map((s) => [s.key, s]));
  const afterByKey = new Map(after.sections.map((s) => [s.key, s]));
  for (const s of after.sections) {
    const prev = beforeByKey.get(s.key);
    if (!prev) {
      sections.push({ key: s.key, title: s.title, change: "added", lines: lineDiff("", s.markdown) });
    } else if (prev.markdown !== s.markdown) {
      sections.push({
        key: s.key,
        title: s.title,
        change: "changed",
        lines: lineDiff(prev.markdown, s.markdown),
      });
    }
  }
  for (const s of before.sections) {
    if (!afterByKey.has(s.key))
      sections.push({ key: s.key, title: s.title, change: "removed", lines: lineDiff(s.markdown, "") });
  }

  const prevReq = new Map(before.requirements.map((r) => [r.id, r]));
  const nextReq = new Map(after.requirements.map((r) => [r.id, r]));
  const requirements: SpecDiff["requirements"] = { added: [], removed: [], changed: [] };
  for (const r of after.requirements) {
    const p = prevReq.get(r.id);
    if (!p) requirements.added.push(r);
    else if (!sameRequirement(p, r)) requirements.changed.push({ before: p, after: r });
  }
  for (const r of before.requirements) if (!nextReq.has(r.id)) requirements.removed.push(r);
  return { sections, requirements };
}

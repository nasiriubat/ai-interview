import { describe, expect, it } from "vitest";
import { chunkText, DEFAULT_CHUNK } from "../../src/ingest/chunk.js";
import { normalizeText } from "../../src/ingest/extract.js";

const para = (n: number, word = "word"): string => Array.from({ length: n }, () => word).join(" ");

describe("chunkText", () => {
  it("leaves a short document as one chunk", () => {
    expect(chunkText("A short note about the ward rota.")).toEqual(["A short note about the ward rota."]);
  });

  it("returns nothing for empty or blank text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps every chunk under the target when paragraphs allow it", () => {
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${para(40)}`).join("\n\n");

    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DEFAULT_CHUNK.maxChars);
  });

  it("loses no words from the source", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Section ${i}. ${para(30, `w${i}`)}`).join("\n\n");

    const joined = chunkText(text).join(" ");

    // Every distinct token of the source survives somewhere. Overlap means the reverse is not
    // true, so this is a containment check rather than an equality one.
    for (const token of new Set(text.split(/\s+/))) expect(joined).toContain(token);
  });

  it("overlaps consecutive chunks so a passage on a boundary is still retrievable", () => {
    const text = Array.from({ length: 8 }, (_, i) => `Part ${i}. ${para(50, `t${i}`)}`).join("\n\n");

    const chunks = chunkText(text, { overlapChars: 100 });

    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0] ?? "";
    const second = chunks[1] ?? "";
    const carried = first.slice(-60).split(/\s+/).filter(Boolean);
    expect(carried.some((w) => second.includes(w))).toBe(true);
  });

  it("can be told not to overlap", () => {
    const text = Array.from({ length: 6 }, (_, i) => `Part ${i}. ${para(60, `u${i}`)}`).join("\n\n");

    const chunks = chunkText(text, { overlapChars: 0 });

    expect(chunks.join("").length).toBeLessThanOrEqual(text.length + chunks.length);
  });

  it("splits a single runaway paragraph that has no blank lines at all", () => {
    // A badly extracted PDF, or a spreadsheet row dump: one paragraph, many sentences.
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about the ward.`).join(" ");

    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DEFAULT_CHUNK.maxChars);
  });

  it("cuts mid-sentence only when one sentence is longer than the whole target", () => {
    const monster = para(500, "verylongtoken");

    const chunks = chunkText(monster);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(DEFAULT_CHUNK.maxChars);
    // Cut on word boundaries, so no token is sliced in half.
    for (const c of chunks) expect(c).not.toMatch(/verylongtoke$|^erylongtoken/);
  });

  // The bug this caught: the overlap prefix was added unconditionally, so a piece already close
  // to the target produced a chunk over it, and the size guarantee silently stopped holding.
  it("never exceeds the target, whatever the overlap would have added", () => {
    for (const overlap of [0, 120, 400]) {
      const text = Array.from({ length: 20 }, (_, i) => `Part ${i}. ${para(180, `x${i}`)}`).join("\n\n");

      for (const c of chunkText(text, { overlapChars: overlap })) {
        expect(c.length).toBeLessThanOrEqual(DEFAULT_CHUNK.maxChars);
      }
    }
  });

  it("folds a stray short tail into the chunk before it rather than keeping a fragment", () => {
    const text = `${Array.from({ length: 5 }, (_, i) => `Body ${i}. ${para(45, `v${i}`)}`).join("\n\n")}\n\nok.`;

    const chunks = chunkText(text);

    expect(chunks[chunks.length - 1]).toContain("ok.");
    expect((chunks[chunks.length - 1] ?? "").length).toBeGreaterThan(DEFAULT_CHUNK.minChars);
  });

  it("survives text that is only whitespace and punctuation between words", () => {
    // The tab survives normalization on purpose: it is a column boundary in a spreadsheet row.
    expect(chunkText(normalizeText("a\r\n\r\n\r\nb\t\tc   d"))).toEqual(["a\n\nb\tc d"]);
  });
});

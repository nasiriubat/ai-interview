import type { BenchReport } from "../report.js";

/**
 * Text normalisation for "verbatim": case, Unicode form, typographic quotes and punctuation do not
 * matter; the words and their order do. Letters outside ASCII (ä, ö, å) are kept, so a Finnish quote
 * is compared as Finnish.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function words(text: string): string[] {
  const n = normalizeText(text);
  return n ? n.split(" ") : [];
}

const MIN_QUOTE_WORDS = 4;

/**
 * Every quotation the report presents as a participant's words: Markdown blockquote lines, text in
 * typographic or straight double quotes of at least four words, and the quotes the opportunities
 * carry. An attribution tail ("— warehouse supervisor") is cut off. Deduplicated on normalised text.
 */
export function extractQuotes(report: Pick<BenchReport, "markdown" | "opportunities">): string[] {
  const found: string[] = [];
  const stripAttribution = (q: string): string => q.replace(/\s+[—–-]{1,2}\s+[^—–]{1,60}$/u, "").trim();
  const unwrap = (q: string): string => q.replace(/^["“”«»']+|["“”«»']+$/gu, "").trim();
  let inFence = false;
  for (const line of report.markdown.split("\n")) {
    // Code fences hold process maps (Mermaid node labels in quotes), not anybody's words.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // One blockquote line is one quote: the report renders consecutive quotes as consecutive lines.
    const m = /^\s*>\s?(.*)$/.exec(line);
    if (m) found.push(unwrap(stripAttribution((m[1] ?? "").trim())));
    else for (const q of line.matchAll(/“([^”]+)”|"([^"\n]+)"/gu)) found.push((q[1] ?? q[2] ?? "").trim());
  }
  for (const o of report.opportunities) found.push(...o.quotes.map((q) => unwrap(q)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of found) {
    const key = normalizeText(q);
    if (words(q).length < MIN_QUOTE_WORDS || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

export type QuoteVerdict = "verbatim" | "near_verbatim" | "not_found";

export interface QuoteCheck {
  quote: string;
  verdict: QuoteVerdict;
  /** Share of the quote's words found in order in the best-matching participant answer, 0..1. */
  coverage: number;
}

/** Longest common subsequence length of two word arrays (quotes are short; O(n*m) is fine). */
function lcs(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      prev[j] = x === b[j - 1] ? diag + 1 : Math.max(up, prev[j - 1] ?? 0);
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/**
 * Checks one quote against the participants' answers (never the interviewer's words).
 * `verbatim`: the normalised quote is a substring of one answer; an ellipsis ("..." or "…") splits
 * it into pieces that must each be present, in order, in the same answer.
 * `near_verbatim`: at least 80 percent of its words appear in order in one answer (light edits,
 * a dropped word): presented as a quote but altered.
 * `not_found`: anything else, including a translation or a paraphrase.
 */
export function checkQuote(quote: string, answers: string[]): QuoteCheck {
  const pieces = quote
    .split(/\.{3,}|…|\[\.\.\.\]/u)
    .map(normalizeText)
    .filter((p) => p.length > 0);
  const qWords = words(quote);
  let best = 0;
  for (const answer of answers) {
    const hay = normalizeText(answer);
    let from = 0;
    let all = pieces.length > 0;
    for (const p of pieces) {
      const at = ` ${hay} `.indexOf(` ${p} `, from);
      if (at < 0) {
        all = false;
        break;
      }
      from = at + p.length;
    }
    if (all) return { quote, verdict: "verbatim", coverage: 1 };
    if (qWords.length) best = Math.max(best, lcs(qWords, words(answer)) / qWords.length);
  }
  return {
    quote,
    verdict: best >= 0.8 ? "near_verbatim" : "not_found",
    coverage: Math.round(best * 100) / 100,
  };
}

/** Points per verdict: an altered quote is half right, an invented one is wrong. */
export const QUOTE_POINTS: Record<QuoteVerdict, number> = { verbatim: 1, near_verbatim: 0.5, not_found: 0 };

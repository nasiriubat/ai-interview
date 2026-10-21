/*
 * Evidence verification for the collective analysis (D-478).
 *
 * Everything here is deterministic and runs before a report version is stored, so what an
 * administrator (and anyone they share the report with) reads has been checked:
 *
 * 1. Quotes. A quote is shown only when its words are found, in order, in what the participant
 *    said in the interview it cites. "Found" is defined by `matchQuote` below.
 * 2. Figures. A sentence the model wrote that states a campaign figure (how many interviews or
 *    people, a share of them, hours per week) is kept only when that figure matches a value the
 *    code computed. A sentence whose figure cannot be confirmed is removed.
 *
 * Both checks report what they dropped, and the counts are stored with the analysis version.
 */

/** Share of a quote segment's words that must align with the transcript (see `matchQuote`). */
export const QUOTE_MATCH_THRESHOLD = 0.85;
/** Words an ellipsis may stand for between two quoted segments: a trim, not a splice. */
export const MAX_ELLIPSIS_GAP = 40;

const ELLIPSIS = /\[\s*(?:\.\s*){3}\]|\[\s*…\s*\]|\.{3,}|…/g;

/**
 * Words of a text for comparison: compatibility forms folded, lower case, typographic quotes and
 * apostrophes made plain, every punctuation mark and run of whitespace a single break. Apostrophes
 * inside a word are dropped rather than treated as breaks, so "don't" and "dont" compare equal.
 */
export function quoteTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/(\p{L})'(\p{L})/gu, "$1$2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Levenshtein distance capped at 2; enough to tell a typo from a different word. */
function charDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > 1) return 2;
    prev = cur;
  }
  return prev[b.length] ?? 2;
}

/** Two words are the same word, or the same long word with one typing slip. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && charDistance(a, b) <= 1;
}

interface Hit {
  start: number;
  end: number;
  distance: number;
}

/**
 * The best approximate occurrence of `pattern` inside `text[from..]` (Sellers' algorithm: edit
 * distance against any substring), with where it starts and ends. O(pattern × text).
 */
function bestOccurrence(pattern: readonly string[], text: readonly string[], from: number): Hit | null {
  const m = pattern.length;
  if (m === 0) return { start: from, end: from, distance: 0 };
  // Column j holds, for each pattern prefix i, the cost and the text start of the best alignment
  // that ends at text position j.
  let cost = Array.from({ length: m + 1 }, (_, i) => i);
  let start = Array.from({ length: m + 1 }, () => from);
  let best: Hit | null = null;
  for (let j = from; j < text.length; j++) {
    const nextCost = [0];
    const nextStart = [j + 1];
    const word = text[j] ?? "";
    for (let i = 1; i <= m; i++) {
      const sub = (cost[i - 1] ?? 0) + (sameWord(pattern[i - 1] ?? "", word) ? 0 : 1);
      const del = (cost[i] ?? 0) + 1; // a text word the quote left out
      const ins = (nextCost[i - 1] ?? 0) + 1; // a quote word the text does not have
      if (sub <= del && sub <= ins) {
        nextCost.push(sub);
        nextStart.push(i === 1 ? j : (start[i - 1] ?? j));
      } else if (del <= ins) {
        nextCost.push(del);
        nextStart.push(start[i] ?? j);
      } else {
        nextCost.push(ins);
        nextStart.push(nextStart[i - 1] ?? j);
      }
    }
    cost = nextCost;
    start = nextStart;
    const d = cost[m] ?? m;
    if (!best || d < best.distance) best = { start: start[m] ?? j, end: j + 1, distance: d };
    if (d === 0) break;
  }
  return best;
}

export interface QuoteMatch {
  ok: boolean;
  /** Share of the quote's words that aligned, 0 to 1, for the best message. */
  score: number;
}

/**
 * Whether a quote is the participant's own words in one of their messages.
 *
 * The quote is cut at ellipses into segments. Each segment must occur in the same message, in
 * order, with at most `MAX_ELLIPSIS_GAP` words skipped between two segments. A segment occurs when
 * an alignment against the message's words reaches `QUOTE_MATCH_THRESHOLD` (85%): for a twenty-word
 * segment that is three words dropped, added or changed, which absorbs a speech-to-text slip, a
 * filler word left out or an expanded contraction. A paraphrase rewords and reorders far more than
 * that, and an invented quote has nothing to align with. Segments shorter than seven words must
 * match exactly (85% of six words leaves no room), and a quote of fewer than three words in total is
 * never verified: a short phrase is too easy to find by chance.
 */
export function matchQuote(quote: string, messages: readonly string[]): QuoteMatch {
  const segments = quote
    .split(ELLIPSIS)
    .map(quoteTokens)
    .filter((s) => s.length > 0);
  const total = segments.reduce((n, s) => n + s.length, 0);
  if (total < 3) return { ok: false, score: 0 };
  let bestScore = 0;
  for (const message of messages) {
    const words = quoteTokens(message);
    if (words.length === 0) continue;
    let from = 0;
    let previousEnd = -1;
    let distance = 0;
    let ok = true;
    for (const seg of segments) {
      const hit = bestOccurrence(seg, words, from);
      const allowed = Math.floor(seg.length * (1 - QUOTE_MATCH_THRESHOLD));
      if (!hit || hit.distance > allowed) {
        ok = false;
        distance += hit ? hit.distance : seg.length;
        break;
      }
      if (previousEnd >= 0 && hit.start - previousEnd > MAX_ELLIPSIS_GAP) {
        ok = false;
        distance += seg.length;
        break;
      }
      distance += hit.distance;
      previousEnd = hit.end;
      from = hit.end;
    }
    const score = Math.max(0, 1 - distance / total);
    if (ok) return { ok: true, score };
    bestScore = Math.max(bestScore, score);
  }
  return { ok: false, score: bestScore };
}

// ---------- figures ----------

/** What the code computed about the campaign and, for an opportunity's own text, about it. */
export interface FigureFacts {
  /** Counts a "N interviews / people" claim may state: totals, per-group counts, k, the threshold. */
  counts: readonly number[];
  /** Denominators for "N of M" and for percentages: the campaign's totals of people and interviews. */
  totals: readonly number[];
  /**
   * Numerators for "N of M" and for percentages (D-479): how many people or interviews a group or
   * the campaign has. Absent: any of `counts`. With it, "4 of 12 interviews" must be a group's
   * count over a total, and a share such as 66% must be one of those pairs, not a coincidence of
   * two unrelated campaign figures (started over invited).
   */
  shareNumerators?: readonly number[];
  /**
   * Participation pairs that may be stated as "N of M" ("10 of 15 people who started completed").
   * Never as a percentage: a share in the text is a topic's share of the people, and 67% matched
   * completed over started by coincidence.
   */
  pairs?: readonly (readonly [number, number])[];
  /** Hours per week that were computed (a group's total, a fact's own, the campaign's). */
  hoursPerWeek: readonly number[];
}

export interface FigureCheck {
  text: string;
  /** Figures that were looked at. */
  checked: number;
  /** Sentences removed because a figure in them could not be confirmed. */
  removed: number;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  yksi: 1,
  kaksi: 2,
  kolme: 3,
  neljä: 4,
  viisi: 5,
  kuusi: 6,
  seitsemän: 7,
  kahdeksan: 8,
  yhdeksän: 9,
  kymmenen: 10,
};
const NUM = `(\\d+(?:[.,]\\d+)?|${Object.keys(WORD_NUMBERS).join("|")})`;
const PEOPLE =
  "(?:interviews?|interviewed|interviewees?|participants?|people|persons?|employees?|respondents?|staff members?|colleagues?|team members?|haastattelu\\p{L}*|haastatelt\\p{L}*|osallistuj\\p{L}*|henkil\\p{L}*|työntekij\\p{L}*|vastaaj\\p{L}*)";
/** "about", "around": the claim is an approximation and gets a wider tolerance. */
const APPROX =
  /(?:about|around|approximately|roughly|nearly|almost|some|over|more than|less than|fewer than|under|at least|up to|noin|lähes|yli|alle|vähintään|ainakin)\s*$/i;

const PATTERNS: { kind: "of" | "count" | "percent" | "hours"; re: RegExp }[] = [
  {
    kind: "of",
    re: new RegExp(
      `\\b${NUM}\\s+(?:out\\s+)?of\\s+(?:the\\s+|all\\s+)?${NUM}\\s+(?:\\p{L}+\\s+)?${PEOPLE}`,
      "giu",
    ),
  },
  {
    kind: "percent",
    re: new RegExp(
      `\\b${NUM}\\s*(?:%|percent|per cent|prosenttia)(?=\\s+(?:of\\s+(?:the\\s+|all\\s+)?)?${PEOPLE})`,
      "giu",
    ),
  },
  { kind: "count", re: new RegExp(`\\b${NUM}\\s+(?:\\p{L}+\\s+)?${PEOPLE}`, "giu") },
  {
    kind: "hours",
    re: new RegExp(
      `\\b${NUM}\\s*(?:hours?|h|tuntia|tunnin)\\s*(?:(?:per|a|each|every)\\s+week|weekly|/\\s*week|viikossa|viikoittain)`,
      "giu",
    ),
  },
];

function toNumber(raw: string): number {
  const w = WORD_NUMBERS[raw.toLowerCase()];
  return w ?? Number(raw.replace(",", "."));
}

const near = (value: number, allowed: readonly number[], tolerance: (x: number) => number): boolean =>
  allowed.some((a) => Math.abs(a - value) <= tolerance(a));

/** Whether one claim matches what was computed; `approx` widens the tolerance. */
function confirmed(
  kind: "of" | "count" | "percent" | "hours",
  values: number[],
  facts: FigureFacts,
  approx: boolean,
): boolean {
  const exact = (x: number): number => (approx ? Math.max(1, Math.round(x * 0.15)) : 0);
  switch (kind) {
    case "count":
      return near(values[0] ?? NaN, facts.counts, exact);
    case "of": {
      const [a = NaN, b = NaN] = values;
      const numerators = facts.shareNumerators ?? facts.counts;
      if (a <= b && near(a, numerators, exact) && near(b, facts.totals, exact)) return true;
      return (facts.pairs ?? []).some(([x, y]) => Math.abs(x - a) <= exact(x) && Math.abs(y - b) <= exact(y));
    }
    case "percent": {
      const p = values[0] ?? NaN;
      const shares: number[] = [];
      for (const a of facts.shareNumerators ?? facts.counts)
        for (const b of facts.totals) if (b > 0 && a <= b) shares.push((100 * a) / b);
      return near(p, shares, () => (approx ? 5 : 1.5));
    }
    case "hours":
      return near(values[0] ?? NaN, facts.hoursPerWeek, (x) => Math.max(1, x * (approx ? 0.2 : 0.1)));
  }
}

/** Sentences, each keeping its own trailing punctuation and space. */
function sentences(text: string): string[] {
  return text.match(/[^.!?]+(?:[.!?]+(?:\s+|$)|$)/g) ?? [text];
}

/**
 * Checks every campaign figure in a piece of model-written text against `facts`, removing each
 * sentence that states one that does not match. When every sentence would go, the text is kept and
 * the unconfirmed figures are replaced by `placeholder`, so a field that must not be empty is not.
 */
export function checkFigures(
  text: string,
  facts: FigureFacts,
  placeholder = "[figure removed]",
): FigureCheck {
  let checked = 0;
  let removed = 0;
  const kept: string[] = [];
  const bad: { sentence: string; spans: [number, number][] }[] = [];
  for (const sentence of sentences(text)) {
    const spans: [number, number][] = [];
    // "3 of 12 interviews" also reads as "12 interviews": a number one pattern claimed is not
    // claimed again by the next.
    const claimed = new Set<number>();
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      for (const m of sentence.matchAll(re)) {
        const at = m.index;
        if (claimed.has(at)) continue;
        claimed.add(at);
        if (kind === "of" && m[2] !== undefined) {
          const ofAt = m[0].search(/\s(?:out\s+)?of\s/iu);
          const second = m[0].indexOf(m[2], ofAt);
          if (second >= 0) claimed.add(at + second);
        }
        const values = [m[1], m[2]].filter((x): x is string => x !== undefined).map(toNumber);
        if (values.some((v) => !Number.isFinite(v))) continue;
        checked++;
        const before = sentence.slice(Math.max(0, at - 24), at);
        if (!confirmed(kind, values, facts, APPROX.test(before))) spans.push([at, at + m[0].length]);
      }
    }
    if (spans.length === 0) kept.push(sentence);
    else {
      removed++;
      bad.push({ sentence, spans });
    }
  }
  if (removed === 0) return { text, checked, removed };
  if (kept.join("").trim() !== "") return { text: kept.join("").trim(), checked, removed };
  // Nothing would be left: keep the wording, strike the figures.
  const struck = bad
    .map(({ sentence, spans }) => {
      let out = sentence;
      for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0]))
        out = `${out.slice(0, a)}${placeholder}${out.slice(b)}`;
      return out;
    })
    .join("")
    .trim();
  return { text: struck, checked, removed };
}

import { contentTokens, quoteIsVerbatim } from "@aidp/ai";

/**
 * Recall and precision of a requirement list against what the OWNER said (D-300).
 *
 * The earlier "stated capabilities no requirement covers" figure let one model both list what the
 * owner stated and judge coverage, with nothing checked in code. Here the owner's stated
 * capabilities come from an independent extraction pass, every one must carry a quote that is
 * verbatim in the owner's own messages (an unverifiable one is dropped, not counted), and coverage is
 * decided deterministically where words settle it and by a model only for the uncertain middle.
 * `tools/evals/live/recall.live.ts` makes the model calls; everything else is here and unit tested.
 */

export interface StatedCapability {
  key: string;
  /** The capability in the extractor's words. */
  text: string;
  /** The owner's words that state it, copied from an OWNER message. */
  quote: string;
  /** What kind of thing the owner stated; a constraint is reported but not part of recall. */
  kind?: "feature" | "constraint" | undefined;
}

export interface ListedRequirement {
  id: string;
  title: string;
  acceptance: string[];
  evidence?: string | undefined;
  /**
   * Nothing of what was merged into it is read: a reader of the document sees the survivor's title
   * and acceptance criteria only, so a capability whose title was merged away counts as covered
   * only when its words reached the survivor's text.
   */
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  const shared = a.filter((x) => sb.has(x)).length;
  return shared / (a.length + b.length - shared);
}

/** Keeps the stated capabilities whose quote is the owner's own, one per distinct statement. */
export function verifyStated(
  raw: readonly Partial<StatedCapability>[],
  ownerTexts: readonly string[],
  minQuoteWords = 3,
): { verified: StatedCapability[]; rejected: { reason: string; text: string }[] } {
  const verified: StatedCapability[] = [];
  const rejected: { reason: string; text: string }[] = [];
  const seen: string[][] = [];
  let n = 0;
  for (const c of raw) {
    const text = (c.text ?? "").trim();
    const quote = (c.quote ?? "").trim();
    if (!text) {
      rejected.push({ reason: "no text", text: quote });
      continue;
    }
    if (quote.split(/\s+/).filter(Boolean).length < minQuoteWords) {
      rejected.push({ reason: "quote too short", text });
      continue;
    }
    if (!quoteIsVerbatim(quote, ownerTexts)) {
      rejected.push({ reason: "quote not in the owner's words", text });
      continue;
    }
    const toks = contentTokens(`${text} ${quote}`);
    if (seen.some((s) => jaccard(s, toks) >= 0.7)) {
      rejected.push({ reason: "duplicate of an earlier capability", text });
      continue;
    }
    seen.push(toks);
    n++;
    verified.push({
      key: `c${n}`,
      text,
      quote,
      kind: c.kind === "feature" || c.kind === undefined ? "feature" : "constraint",
    });
  }
  return { verified, rejected };
}

function containment(cap: readonly string[], text: ReadonlySet<string>): number {
  if (cap.length === 0) return 0;
  return cap.filter((w) => text.has(w)).length / cap.length;
}

export interface Candidate {
  reqId: string;
  score: number;
}

export interface CapabilityMatch {
  key: string;
  /** Requirements ranked by word overlap, best first, zero scores dropped. */
  candidates: Candidate[];
  /** "yes" and "no" are settled by words alone; "unsure" goes to the model. */
  decision: "yes" | "no" | "unsure";
  by: string | null;
  /** True when a requirement's own evidence quote is the owner's quote. */
  viaEvidence: boolean;
}

export const AUTO_YES = 0.67;
export const AUTO_NO = 0.2;

/** The requirement's evidence and the capability's quote are the same words (one holds the other). */
export function evidenceMatches(evidence: string, quote: string): boolean {
  const a = contentTokens(evidence);
  const b = contentTokens(quote);
  if (a.length < 3 || b.length < 3) return false;
  const sa = new Set(a);
  const shared = b.filter((w) => sa.has(w)).length;
  return shared / Math.min(a.length, b.length) >= 0.8;
}

/**
 * Deterministic coverage. A requirement covers a capability outright when its evidence quote is the
 * capability's quote (the interviewer filed it from those very words), or the capability's words
 * are at least two thirds present in it (titles weigh more than acceptance). When no requirement
 * shares a fifth of them it is uncovered without asking a model. Between the two a model decides,
 * from the candidates only.
 */
export function matchCapabilities(
  caps: readonly StatedCapability[],
  reqs: readonly ListedRequirement[],
  thresholds: { yes: number; no: number } = { yes: AUTO_YES, no: AUTO_NO },
): CapabilityMatch[] {
  const views = reqs.map((r) => {
    const text = `${r.title} ${r.acceptance.join(" ")}`;
    return { r, words: new Set(contentTokens(text)), titleWords: new Set(contentTokens(r.title)) };
  });
  return caps.map((c): CapabilityMatch => {
    const capWords = contentTokens(`${c.text} ${c.quote}`);
    const textWords = contentTokens(c.text);
    const candidates = views
      .map((v) => ({
        reqId: v.r.id,
        score: 0.6 * containment(textWords, v.titleWords) + 0.4 * containment(capWords, v.words),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.reqId.localeCompare(b.reqId));
    const ev = reqs.find((r) => r.evidence && evidenceMatches(r.evidence, c.quote));
    if (ev) return { key: c.key, candidates, decision: "yes", by: ev.id, viaEvidence: true };
    const best = candidates[0];
    if (best && best.score >= thresholds.yes) {
      return { key: c.key, candidates, decision: "yes", by: best.reqId, viaEvidence: false };
    }
    if (!best || best.score < thresholds.no) {
      return { key: c.key, candidates, decision: "no", by: null, viaEvidence: false };
    }
    return { key: c.key, candidates, decision: "unsure", by: null, viaEvidence: false };
  });
}

export interface Settled {
  key: string;
  covered: boolean;
  by: string | null;
  how: "evidence" | "words" | "model" | "none";
}

/** Applies a model's answers to the unsure cases; an unanswered or invalid one stays uncovered. */
export function settleMatches(
  matches: readonly CapabilityMatch[],
  answers: Readonly<Record<string, string | null | undefined>>,
  reqIds: ReadonlySet<string>,
): Settled[] {
  return matches.map((m): Settled => {
    if (m.decision === "yes") {
      return { key: m.key, covered: true, by: m.by, how: m.viaEvidence ? "evidence" : "words" };
    }
    if (m.decision === "unsure") {
      const a = answers[m.key];
      // The model may only name a requirement the code offered it as a candidate.
      if (typeof a === "string" && reqIds.has(a) && m.candidates.some((c) => c.reqId === a)) {
        return { key: m.key, covered: true, by: a, how: "model" };
      }
    }
    return { key: m.key, covered: false, by: null, how: "none" };
  });
}

// ---------- precision ----------

export interface PrecisionRow {
  id: string;
  evidenceVerified: boolean;
  matched: boolean;
  supported: boolean;
}

/**
 * A requirement is supported when its own evidence is the owner's words, or a stated capability
 * is covered by it. An unsupported one is not necessarily wrong (the owner may have accepted an
 * interviewer proposal with "yes"), so precision here is a lower bound.
 */
export function precisionRows(
  reqs: readonly ListedRequirement[],
  coveredBy: readonly (string | null)[],
  ownerTexts: readonly string[],
): PrecisionRow[] {
  const matched = new Set(coveredBy.filter((x): x is string => x !== null));
  return reqs.map((r) => {
    const evidenceVerified = !!r.evidence && quoteIsVerbatim(r.evidence, ownerTexts);
    const m = matched.has(r.id);
    return { id: r.id, evidenceVerified, matched: m, supported: evidenceVerified || m };
  });
}

// ---------- statistics ----------

export interface Interval {
  rate: number | null;
  low: number | null;
  high: number | null;
  k: number;
  n: number;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Wilson score interval, 95%. Treats items as independent, which items of one interview are not. */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n === 0) return { rate: null, low: null, high: null, k, n };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    rate: round3(p),
    low: round3(Math.max(0, (c - h) / d)),
    high: round3(Math.min(1, (c + h) / d)),
    k,
    n,
  };
}

/** A small deterministic generator, so a bootstrap is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap over interviews (the cluster), pooling items. With a handful of interviews
 * this is wide, which is the honest answer; it is returned beside Wilson, which is too narrow.
 */
export function clusterBootstrap(
  clusters: readonly { k: number; n: number }[],
  iterations = 2000,
  seed = 7,
): { low: number | null; high: number | null } {
  const usable = clusters.filter((c) => c.n > 0);
  if (usable.length < 2) return { low: null, high: null };
  const rnd = mulberry32(seed);
  const rates: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let k = 0;
    let n = 0;
    usable.forEach(() => {
      const c = usable[Math.floor(rnd() * usable.length)];
      if (!c) return;
      k += c.k;
      n += c.n;
    });
    if (n > 0) rates.push(k / n);
  }
  rates.sort((a, b) => a - b);
  const q = (p: number): number => rates[Math.min(rates.length - 1, Math.floor(p * rates.length))] ?? 0;
  return { low: round3(q(0.025)), high: round3(q(0.975)) };
}

export interface InterviewScore {
  spec: string;
  persona: string;
  capabilities: number;
  covered: number;
  requirements: number;
  supported: number;
}

interface Boot {
  low: number | null;
  high: number | null;
}

export interface PersonaScore {
  persona: string;
  interviews: number;
  recall: Interval & { bootstrap: Boot };
  precision: Interval & { bootstrap: Boot };
  perInterviewRecall: (number | null)[];
}

/** Pools interviews per persona (and "all"), with both interval kinds. */
export function summarize(scores: readonly InterviewScore[]): PersonaScore[] {
  const personas = [...new Set(scores.map((s) => s.persona))];
  const groups: [string, readonly InterviewScore[]][] = [
    ...personas.map((p): [string, readonly InterviewScore[]] => [p, scores.filter((s) => s.persona === p)]),
    ["all", scores],
  ];
  return groups.map(([persona, xs]) => ({
    persona,
    interviews: xs.length,
    recall: {
      ...wilson(
        xs.reduce((n, s) => n + s.covered, 0),
        xs.reduce((n, s) => n + s.capabilities, 0),
      ),
      bootstrap: clusterBootstrap(xs.map((s) => ({ k: s.covered, n: s.capabilities }))),
    },
    precision: {
      ...wilson(
        xs.reduce((n, s) => n + s.supported, 0),
        xs.reduce((n, s) => n + s.requirements, 0),
      ),
      bootstrap: clusterBootstrap(xs.map((s) => ({ k: s.supported, n: s.requirements }))),
    },
    perInterviewRecall: xs.map((s) => (s.capabilities === 0 ? null : round3(s.covered / s.capabilities))),
  }));
}

/**
 * Splits the loss between stages: of the capabilities the final list misses, which did the
 * recorded requirements (before curation) cover. Those were lost after capture, by merge, folding
 * or withdrawal; the rest were never recorded.
 */
export function attributeLoss(
  coveredRecorded: ReadonlySet<string>,
  coveredFinal: ReadonlySet<string>,
  keys: readonly string[],
): { neverRecorded: string[]; lostAfterCapture: string[]; gainedAfterCapture: string[] } {
  const neverRecorded: string[] = [];
  const lostAfterCapture: string[] = [];
  const gainedAfterCapture: string[] = [];
  for (const k of keys) {
    const rec = coveredRecorded.has(k);
    const fin = coveredFinal.has(k);
    if (!fin && !rec) neverRecorded.push(k);
    else if (!fin && rec) lostAfterCapture.push(k);
    else if (fin && !rec) gainedAfterCapture.push(k);
  }
  return { neverRecorded, lostAfterCapture, gainedAfterCapture };
}

// ---------- what merging dropped ----------

export interface MergedAway {
  survivor: string;
  id: string;
  title: string;
  /** Share of the merged-away title's content words that the survivor's text still holds. */
  kept: number;
  /** How many of its content words the survivor's text lacks. */
  missing: number;
}

/**
 * Deterministic check of the merge pass, no model: for every requirement merged into another, how
 * much of its title survived in the survivor's title and acceptance criteria. A merged requirement
 * whose words did not survive is a capability the document no longer names. `titleOf` maps the
 * merged ids to the titles they had when recorded.
 */
export function mergedAway(
  survivors: readonly {
    id: string;
    title: string;
    acceptance: string[];
    mergedFrom?: string[] | undefined;
  }[],
  titleOf: ReadonlyMap<string, string>,
): MergedAway[] {
  const out: MergedAway[] = [];
  for (const s of survivors) {
    const words = new Set(contentTokens(`${s.title} ${s.acceptance.join(" ")}`));
    for (const id of s.mergedFrom ?? []) {
      const title = titleOf.get(id);
      if (!title) continue;
      const t = contentTokens(title);
      if (t.length === 0) continue;
      out.push({
        survivor: s.id,
        id,
        title,
        kept: round3(t.filter((w) => words.has(w)).length / t.length),
        missing: t.filter((w) => !words.has(w)).length,
      });
    }
  }
  return out;
}

/** Merged requirements whose title did not survive: under a share of its words held and at least two words missing (the rule of `mergeGroup`). */
export const lostTitles = (m: readonly MergedAway[], below = 0.8): MergedAway[] =>
  m.filter((x) => x.kept < below && x.missing >= 2);

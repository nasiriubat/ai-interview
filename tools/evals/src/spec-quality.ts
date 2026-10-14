import { quoteIsVerbatim } from "@aidp/ai";

/**
 * The deterministic half of the specification-quality judge (D-245). A model scores each
 * requirement against the transcript; everything that can be checked without a model is checked
 * here: the judge's evidence quote must be the participant's own words, ids must exist, a
 * duplicate-of must point at another requirement, and the aggregation into rates is plain
 * arithmetic that a unit test pins. `tools/evals/live/spec-quality.live.ts` makes the model calls.
 */

export type KindLabel = "capability" | "decision" | "constraint" | "question" | "detail";

export interface RequirementUnderJudgement {
  id: string;
  title: string;
  scope: "mvp" | "future";
  acceptance: string[];
  reason?: string | undefined;
  mergedFrom?: string[] | undefined;
}

/** One requirement's raw verdict, as the judge returns it (every field optional: models drift). */
export interface RawVerdict {
  id: string;
  /** Does the participant's own transcript support this requirement? */
  grounded?: "yes" | "partial" | "no";
  /** The participant's words that support it, copied from the transcript. */
  quote?: string;
  /** Is it one demonstrable capability (not a detail of another, not several)? */
  granularity?: "ok" | "too_fine" | "too_coarse";
  kind?: KindLabel;
  /** Could a tester answer each acceptance criterion with yes or no? */
  testable?: "yes" | "partly" | "no";
  scope?: "correct" | "wrong" | "unclear";
  duplicateOf?: string | null;
}

export interface Verdict {
  id: string;
  grounded: "yes" | "partial" | "no";
  /** What the judge said before the quote was checked. */
  groundedClaimed: "yes" | "partial" | "no";
  /** True when `grounded` is yes and the quote is verified verbatim in the participant's words. */
  groundedVerified: boolean;
  quote: string;
  granularity: "ok" | "too_fine" | "too_coarse";
  kind: KindLabel;
  testable: "yes" | "partly" | "no";
  scope: "correct" | "wrong" | "unclear";
  duplicateOf: string | null;
  /** What the deterministic checks changed in the raw verdict. */
  adjustments: string[];
}

/**
 * Applies the checks a model cannot be trusted with: a "yes" for grounded needs a verbatim quote
 * (else it becomes "partial"), a duplicate-of must name another listed requirement and not the
 * requirement itself, and a missing field takes the harshest reading so silence never improves a score.
 */
export function verifyVerdicts(
  reqs: readonly RequirementUnderJudgement[],
  raw: readonly RawVerdict[],
  participantTexts: readonly string[],
): Verdict[] {
  const ids = new Set(reqs.map((r) => r.id));
  const byId = new Map(raw.map((r) => [r.id, r]));
  return reqs.map((req) => {
    const r = byId.get(req.id);
    const adjustments: string[] = [];
    if (!r) adjustments.push("judge returned no verdict");
    let grounded = r?.grounded ?? "no";
    const groundedClaimed = grounded;
    const quote = (r?.quote ?? "").trim();
    let groundedVerified = false;
    if (grounded === "yes") {
      if (quote && quoteIsVerbatim(quote, participantTexts)) groundedVerified = true;
      else {
        grounded = "partial";
        adjustments.push(quote ? "quote not in the participant's words" : "grounded yes without a quote");
      }
    }
    let duplicateOf = r?.duplicateOf ?? null;
    if (duplicateOf !== null && (!ids.has(duplicateOf) || duplicateOf === req.id)) {
      adjustments.push(`duplicateOf ${duplicateOf} is not another requirement`);
      duplicateOf = null;
    }
    return {
      id: req.id,
      grounded,
      groundedClaimed,
      groundedVerified,
      quote,
      granularity: r?.granularity ?? "ok",
      kind: r?.kind ?? "capability",
      testable: r?.testable ?? "no",
      scope: r?.scope ?? "unclear",
      duplicateOf,
      adjustments,
    };
  });
}

/**
 * Applies the judge's grouping of the whole list into same-capability clusters: every member but
 * the earliest of a group is a duplicate of that earliest one. Ids that are not listed are ignored,
 * and a requirement in two groups keeps the first.
 */
export function applyClusters(
  verdicts: readonly Verdict[],
  groups: readonly (readonly string[])[],
): Verdict[] {
  const listed = new Set(verdicts.map((v) => v.id));
  const order = new Map(verdicts.map((v, i) => [v.id, i]));
  const assigned = new Map<string, string>();
  for (const g of groups) {
    const members = [...new Set(g)].filter((id) => listed.has(id) && !assigned.has(id));
    if (members.length < 2) continue;
    members.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const [head, ...rest] = members;
    if (head === undefined) continue;
    for (const id of rest) assigned.set(id, head);
  }
  return verdicts.map((v) => {
    const head = assigned.get(v.id);
    return head === undefined ? v : { ...v, duplicateOf: head };
  });
}

/**
 * Of a duplicate pair the judge flagged both ways, only the later id is the redundant copy: the
 * count of duplicates is the number of requirements that repeat an earlier one, not twice that.
 */
export function redundantCopies(verdicts: readonly Verdict[]): Set<string> {
  const num = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const out = new Set<string>();
  for (const v of verdicts) {
    if (v.duplicateOf === null) continue;
    out.add(num(v.duplicateOf) < num(v.id) ? v.id : v.duplicateOf);
  }
  return out;
}

export interface SpecScore {
  count: number;
  /** Rates are fractions of `count`, or of the requirements the question applies to. */
  groundedRate: number;
  /**
   * The same rate before the judge's quotes were checked in code. A "yes" whose quote is not
   * verbatim counts here and not in `groundedRate`; the gap is the judge's loose quoting.
   */
  groundedClaimedRate: number;
  duplicateRate: number;
  overGranularRate: number;
  nonRequirementRate: number;
  testableRate: number;
  /**
   * The share of requirements whose mvp or future tag the participant did not contradict (a tag the
   * transcript is silent about is not wrong). 1 minus the contradicted share.
   */
  scopeAccuracy: number;
  /** Requirements the generated specification itself flagged as needing confirmation. */
  flaggedUnconfirmed: number;
}

const rate = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000);

export function scoreSpec(
  verdicts: readonly Verdict[],
  flags: { unconfirmedIds?: readonly string[] } = {},
): SpecScore {
  const n = verdicts.length;
  const redundant = redundantCopies(verdicts);
  return {
    count: n,
    groundedRate: rate(verdicts.filter((v) => v.grounded === "yes").length, n),
    groundedClaimedRate: rate(verdicts.filter((v) => v.groundedClaimed === "yes").length, n),
    duplicateRate: rate(redundant.size, n),
    overGranularRate: rate(
      verdicts.filter((v) => v.granularity === "too_fine" || v.kind === "detail").length,
      n,
    ),
    nonRequirementRate: rate(
      verdicts.filter((v) => v.kind === "decision" || v.kind === "constraint" || v.kind === "question")
        .length,
      n,
    ),
    testableRate: rate(verdicts.filter((v) => v.testable === "yes").length, n),
    scopeAccuracy: n === 0 ? 0 : rate(verdicts.filter((v) => v.scope !== "wrong").length, n),
    flaggedUnconfirmed: flags.unconfirmedIds?.length ?? 0,
  };
}

/** Sums verdicts of several specifications into one score (pooled, not an average of rates). */
export function pool(scores: readonly { verdicts: readonly Verdict[] }[]): SpecScore {
  // Duplicates are only defined within one specification, so they are counted per spec first.
  const all = scores.flatMap((s) => s.verdicts);
  const redundant = scores.reduce((n, s) => n + redundantCopies(s.verdicts).size, 0);
  const base = scoreSpec(all);
  return { ...base, duplicateRate: rate(redundant, all.length) };
}

// ---------- agreement with manual labels ----------

export type Dimension = "grounded" | "granularity" | "kind" | "testable" | "scope" | "duplicate";

export interface ManualLabel {
  spec: string;
  id: string;
  grounded: "yes" | "partial" | "no";
  granularity: "ok" | "too_fine" | "too_coarse";
  kind: KindLabel;
  testable: "yes" | "partly" | "no";
  scope: "correct" | "wrong" | "unclear";
  /** The id this one repeats, or null. */
  duplicateOf: string | null;
}

/** Collapses a verdict to the binary question each rate answers, so agreement is on what is reported. */
export function binaryOf(
  dim: Dimension,
  v: Pick<Verdict, "grounded" | "granularity" | "kind" | "testable" | "scope" | "duplicateOf">,
): boolean {
  switch (dim) {
    case "grounded":
      return v.grounded === "yes";
    case "granularity":
      return v.granularity === "too_fine" || v.kind === "detail";
    case "kind":
      return v.kind === "decision" || v.kind === "constraint" || v.kind === "question";
    case "testable":
      return v.testable === "yes";
    case "scope":
      // Only a contradiction is a finding; "correct" and "unclear" are both a tag left standing.
      return v.scope === "wrong";
    case "duplicate":
      return v.duplicateOf !== null;
  }
}

export interface AgreementRow {
  dimension: Dimension;
  n: number;
  agree: number;
  /** Raw agreement, 0..1. */
  agreement: number;
  /** Cohen's kappa; null when chance agreement is total (one class only). */
  kappa: number | null;
  /** Judge said positive, manual negative / judge negative, manual positive. */
  judgeOnly: number;
  manualOnly: number;
}

export function agreement(
  pairs: readonly { judge: Verdict; manual: ManualLabel }[],
  dims: readonly Dimension[] = ["grounded", "granularity", "kind", "testable", "scope", "duplicate"],
): AgreementRow[] {
  return dims.map((dimension) => {
    const used = pairs;
    let tt = 0;
    let tf = 0;
    let ft = 0;
    let ff = 0;
    for (const p of used) {
      const j = binaryOf(dimension, p.judge);
      const m = binaryOf(dimension, p.manual);
      if (j && m) tt++;
      else if (j && !m) tf++;
      else if (!j && m) ft++;
      else ff++;
    }
    const n = used.length;
    const agree = tt + ff;
    const po = n === 0 ? 0 : agree / n;
    const pe = n === 0 ? 0 : ((tt + tf) * (tt + ft) + (ft + ff) * (tf + ff)) / (n * n);
    const kappa = n === 0 || pe === 1 ? null : Math.round(((po - pe) / (1 - pe)) * 1000) / 1000;
    return {
      dimension,
      n,
      agree,
      agreement: Math.round(po * 1000) / 1000,
      kappa,
      judgeOnly: tf,
      manualOnly: ft,
    };
  });
}

// ---------- recall against what the owner said ----------

export interface GoldCapability {
  key: string;
  /** What the owner must be recorded as wanting, in words. */
  description: string;
  /** Any of these (lowercase word stems) in a requirement's title or acceptance counts as covered. */
  anyOf: string[][];
}

/**
 * Recall of a gold list: a capability is covered when some requirement's text holds every word of
 * one of its `anyOf` alternatives. Deterministic and deliberately lenient on wording.
 */
export function goldRecall(
  gold: readonly GoldCapability[],
  reqs: readonly RequirementUnderJudgement[],
): { covered: string[]; missing: string[]; recall: number } {
  const texts = reqs.map((r) => `${r.title} ${r.acceptance.join(" ")}`.toLowerCase());
  const covered: string[] = [];
  const missing: string[] = [];
  for (const g of gold) {
    const hit = texts.some((t) => g.anyOf.some((words) => words.every((w) => t.includes(w))));
    (hit ? covered : missing).push(g.key);
  }
  return { covered, missing, recall: rate(covered.length, gold.length) };
}

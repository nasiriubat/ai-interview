import { normalizeSectionKey, type Fact } from "@aidp/shared";
import type { GoldFact, GoldFinding, GoldRequirement } from "./fixture.js";

/**
 * The metrics of the eval program (engineering plan 3.3, D-192). Pure functions over what a replay
 * observed, so they are tested with hand-built inputs and never depend on the engine.
 */

const lower = (s: string): string => s.toLowerCase();
const containsAll = (text: string, terms: readonly string[]): boolean =>
  terms.every((t) => lower(text).includes(lower(t)));
const round = (n: number): number => Math.round(n * 1000) / 1000;
const ratio = (num: number, den: number, whenEmpty = 1): number => (den === 0 ? whenEmpty : round(num / den));

// ---------- coverage progression ----------

export interface CoverageResult {
  pass: boolean;
  /** Covered-area count after each turn. */
  curve: number[];
  mismatches: string[];
}

/** The curve never goes down, and meets each milestone (`covered` areas after `afterTurn`). */
export function coverageProgression(
  curve: readonly number[],
  milestones: readonly { afterTurn: number; covered: number }[],
): CoverageResult {
  const mismatches: string[] = [];
  for (let i = 1; i < curve.length; i++)
    if ((curve[i] ?? 0) < (curve[i - 1] ?? 0)) mismatches.push(`coverage fell at turn ${i + 1}`);
  for (const m of milestones) {
    // A run that ended earlier holds its last value.
    const at = curve[Math.min(m.afterTurn, curve.length) - 1] ?? 0;
    if (at < m.covered) mismatches.push(`after turn ${m.afterTurn}: ${at} covered, expected ${m.covered}`);
  }
  return { pass: mismatches.length === 0, curve: [...curve], mismatches };
}

// ---------- requirement capture and FR-id integrity ----------

export interface RecordedRequirement {
  path: string;
  title: string;
  scope: "mvp" | "future";
}

export interface CaptureResult {
  gold: number;
  captured: number;
  rate: number;
  missed: string[];
  /** Rules whose text carries a gold requirement's terms: a requirement filed under `rules`. */
  misfiled: number;
  recorded: number;
  /** Captured requirements whose final scope differs from the gold's. */
  scopeWrong: string[];
}

export function requirementCapture(
  gold: readonly GoldRequirement[],
  recorded: readonly RecordedRequirement[],
  rules: readonly string[],
): CaptureResult {
  const missed: string[] = [];
  const scopeWrong: string[] = [];
  let captured = 0;
  for (const g of gold) {
    const hit = recorded.find((r) => containsAll(r.title, g.terms));
    if (!hit) {
      missed.push(g.id);
      continue;
    }
    captured += 1;
    if (hit.scope !== (g.finalScope ?? g.scope)) scopeWrong.push(g.id);
  }
  return {
    gold: gold.length,
    captured,
    rate: ratio(captured, gold.length),
    missed,
    misfiled: rules.filter((r) => gold.some((g) => containsAll(r, g.terms))).length,
    recorded: recorded.length,
    scopeWrong,
  };
}

export interface CuratedQuality {
  /** Requirements left after curation. */
  requirements: number;
  /** Gold requirements that some requirement matches. */
  matched: number;
  /** Requirements that repeat a gold requirement another one already matched. */
  duplicates: number;
  /** Requirements that match no gold requirement. */
  unmatched: number;
  /** matched / requirements: how much of the list is something the owner said, once. */
  precision: number;
}

/**
 * What the requirement list looks like to a reader after curation (D-241 to D-243): each gold
 * requirement once, nothing else. A duplicate is a recorded requirement whose words match a gold
 * requirement that an earlier one already matched.
 */
export function curatedQuality(
  gold: readonly GoldRequirement[],
  recorded: readonly RecordedRequirement[],
): CuratedQuality {
  const taken = new Set<string>();
  let duplicates = 0;
  let unmatched = 0;
  for (const r of recorded) {
    const g = gold.find((x) => containsAll(r.title, x.terms));
    if (!g) unmatched += 1;
    else if (taken.has(g.id)) duplicates += 1;
    else taken.add(g.id);
  }
  return {
    requirements: recorded.length,
    matched: taken.size,
    duplicates,
    unmatched,
    precision: ratio(taken.size, recorded.length),
  };
}

export interface IntegrityResult {
  ok: boolean;
  violations: string[];
}

/** FR ids are `FR-<n>`, unique, and run from 1 without gaps in the order recorded. */
export function frIdIntegrity(paths: readonly string[]): IntegrityResult {
  const violations: string[] = [];
  const seen = new Set<string>();
  paths.forEach((p, i) => {
    if (!/^FR-\d+$/.test(p)) violations.push(`${p}: not an FR id`);
    if (seen.has(p)) violations.push(`${p}: duplicate`);
    seen.add(p);
    if (p !== `FR-${i + 1}`) violations.push(`${p}: expected FR-${i + 1}`);
  });
  return { ok: violations.length === 0, violations };
}

// ---------- spec completeness ----------

export interface RubricInput {
  /** Sections that hold at least one field. */
  filledSections: readonly string[];
  requiredSections: readonly string[];
  requirements: readonly { acceptance: readonly string[]; scope?: string }[];
  minRequirements: number;
}

export interface RubricResult {
  score: number;
  of: number;
  failed: string[];
}

/** A binary rubric over the recorded specification: structure only, no model. */
export function specCompleteness(input: RubricInput): RubricResult {
  const items: [string, boolean][] = [];
  for (const s of input.requiredSections) {
    const key = normalizeSectionKey(s) ?? s;
    items.push([
      `section:${key}`,
      key === "functional" ? input.requirements.length > 0 : input.filledSections.includes(key),
    ]);
  }
  items.push([`requirements>=${input.minRequirements}`, input.requirements.length >= input.minRequirements]);
  items.push([
    "acceptance",
    input.requirements.length > 0 && input.requirements.every((r) => r.acceptance.length > 0),
  ]);
  items.push([
    "scope_tagged",
    input.requirements.length > 0 &&
      input.requirements.every((r) => r.scope === "mvp" || r.scope === "future"),
  ]);
  const failed = items.filter(([, ok]) => !ok).map(([k]) => k);
  return { score: ratio(items.length - failed.length, items.length), of: items.length, failed };
}

// ---------- fact recall after the rolling summary ----------

export interface RecallResult {
  gold: number;
  recalled: number;
  rate: number;
  missed: string[];
}

const factText = (f: Fact): string => JSON.stringify(f);

/**
 * A gold fact marked `mustSurviveSummary` counts as recalled when the structured facts, the rolling
 * summary or the recent window still carry its terms: the context a model would see at the end
 * with no old verbatim turns.
 */
export function factRecall(
  gold: readonly GoldFact[],
  context: { facts: readonly Fact[]; summary: string; window: string },
): RecallResult {
  const must = gold.filter((g) => g.mustSurviveSummary);
  const missed: string[] = [];
  for (const g of must) {
    const inFacts = context.facts.some((f) => containsAll(factText(f), g.terms));
    const inText = containsAll(`${context.summary}\n${context.window}`, g.terms);
    if (!inFacts && !inText) missed.push(g.id);
  }
  return {
    gold: must.length,
    recalled: must.length - missed.length,
    rate: ratio(must.length - missed.length, must.length),
    missed,
  };
}

// ---------- issue detection ----------

export interface IssueScore {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
}

/** A predicted finding matches a gold one of the same type and section; each gold matches once. */
export function issueDetection(
  predicted: readonly { type: string; section: string }[],
  gold: readonly Pick<GoldFinding, "type" | "section">[],
): IssueScore {
  const open = gold.map((g) => ({
    type: g.type,
    section: normalizeSectionKey(g.section) ?? g.section,
  }));
  let tp = 0;
  for (const p of predicted) {
    const section = normalizeSectionKey(p.section) ?? p.section;
    const idx = open.findIndex((g) => g.type === p.type && g.section === section);
    if (idx >= 0) {
      tp += 1;
      open.splice(idx, 1);
    }
  }
  const fp = predicted.length - tp;
  const fn = open.length;
  return {
    tp,
    fp,
    fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
  };
}

// ---------- the turn contract ----------

export interface ContractTally {
  turns: number;
  markerMissed: number;
  failed: number;
  repairCalls: number;
  markerMissRate: number;
  failureRate: number;
}

export function contractTally(
  turns: readonly { markerMissed: boolean; outcome: "clean" | "repaired" | "failed"; repairCalls: number }[],
): ContractTally {
  const markerMissed = turns.filter((t) => t.markerMissed).length;
  const failed = turns.filter((t) => t.outcome === "failed").length;
  return {
    turns: turns.length,
    markerMissed,
    failed,
    repairCalls: turns.reduce((n, t) => n + t.repairCalls, 0),
    markerMissRate: ratio(markerMissed, turns.length, 0),
    failureRate: ratio(failed, turns.length, 0),
  };
}

// ---------- the gate ----------

export type MetricSet = Record<string, number | boolean | string[] | number[]>;

export interface GateRule {
  /** `equal`: must match the baseline exactly. `min`: may not fall by more than the tolerance. `max`: may not rise by more. */
  mode: "equal" | "min" | "max";
}

/** Compares a fresh metric set with its baseline; returns one line per regression. */
export function gate(
  fresh: Readonly<Record<string, number | boolean>>,
  baseline: Readonly<Record<string, number | boolean>>,
  rules: Readonly<Record<string, GateRule["mode"]>>,
  tolerance = 0.02,
): string[] {
  const out: string[] = [];
  for (const [key, mode] of Object.entries(rules)) {
    const a = fresh[key];
    const b = baseline[key];
    if (b === undefined) {
      out.push(`${key}: no baseline (run the baseline update and review the diff)`);
      continue;
    }
    if (a === undefined) {
      out.push(`${key}: not measured`);
      continue;
    }
    if (mode === "equal") {
      if (a !== b) out.push(`${key}: ${String(a)} (baseline ${String(b)})`);
    } else if (typeof a === "number" && typeof b === "number") {
      if (mode === "min" && a < b - tolerance) out.push(`${key}: fell from ${b} to ${a}`);
      if (mode === "max" && a > b + tolerance) out.push(`${key}: rose from ${b} to ${a}`);
    }
  }
  return out;
}

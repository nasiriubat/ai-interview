import type { BenchOpportunity } from "../report.js";
import type { Problem, Scenario } from "../scenario.js";
import { normalizeText } from "./quotes.js";

/**
 * Which planted items one report opportunity covers. `planted`: one or more scenario items (a
 * problem, the works-well area or the distractor). `other_supported`: something real in the
 * transcripts that the scenario did not plant (fine, neither rewarded nor punished).
 * `unsupported`: nothing in the transcripts backs it.
 */
export interface OpportunityMatch {
  opportunityId: string;
  kind: "planted" | "other_supported" | "unsupported";
  problemIds: string[];
  note: string;
}

/** Problem id to the persona ids whose transcript actually shows it (the observed prevalence). */
export type Observed = Record<string, string[]>;

/** Count of distinct scenario keywords present at a word start in the text. */
export function keywordHits(problem: Pick<Problem, "keywords">, text: string): number {
  const hay = ` ${normalizeText(text)}`;
  let hits = 0;
  for (const kw of new Set(problem.keywords.map((k) => normalizeText(k)))) {
    if (kw && hay.includes(` ${kw}`)) hits += 1;
  }
  return hits;
}

/**
 * The deterministic mapping: each opportunity goes to the scenario item whose keywords it hits
 * most, when it hits at least two. Used as a cross-check of the judge and as the fallback when no
 * judge ran. It cannot see "unsupported", so it says `other_supported` for anything unmatched.
 */
export function keywordMapping(scenario: Scenario, opportunities: BenchOpportunity[]): OpportunityMatch[] {
  return opportunities.map((o) => {
    const text = `${o.title}. ${o.summary}`;
    let best: { id: string; hits: number } | null = null;
    for (const p of scenario.problems) {
      const hits = keywordHits(p, text);
      if (hits >= 2 && (!best || hits > best.hits)) best = { id: p.id, hits };
    }
    return best
      ? {
          opportunityId: o.id,
          kind: "planted" as const,
          problemIds: [best.id],
          note: `${best.hits} keyword hits`,
        }
      : { opportunityId: o.id, kind: "other_supported" as const, problemIds: [], note: "no keyword match" };
  });
}

/** Opportunity ids per problem id, from a mapping. */
export function opportunitiesByProblem(matches: OpportunityMatch[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of matches)
    for (const pid of m.problemIds) out.set(pid, [...(out.get(pid) ?? []), m.opportunityId]);
  return out;
}

/** Share of opportunities on which two mappings name the same primary item, 0..1. */
export function mappingAgreement(a: OpportunityMatch[], b: OpportunityMatch[]): number {
  if (!a.length) return 1;
  const other = new Map(b.map((m) => [m.opportunityId, m]));
  let same = 0;
  for (const m of a) {
    const o = other.get(m.opportunityId);
    const pa = m.problemIds[0] ?? "-";
    const pb = o?.problemIds[0] ?? "-";
    if (pa === pb) same += 1;
  }
  return same / a.length;
}

/** The observed count for a problem, falling back to the planted count when nothing was observed. */
export function observedCount(problem: Problem, observed: Observed | null): number {
  return observed ? (observed[problem.id] ?? []).length : problem.plantedIn.length;
}

import { rankedOpportunities, type BenchOpportunity, type BenchReport } from "../report.js";
import type { Problem, Scenario } from "../scenario.js";
import { opportunitiesByProblem, observedCount, type Observed, type OpportunityMatch } from "./match.js";
import { checkQuote, extractQuotes, QUOTE_POINTS } from "./quotes.js";

export interface Criterion {
  key: CriterionKey;
  label: string;
  weight: number;
  /** 0..10, or null when the criterion could not be measured (its weight is then left out). */
  score: number | null;
  evidence: string[];
}

export const CRITERIA = {
  recall: { label: "Recall of planted problems", weight: 20 },
  prevalence: { label: "Prevalence accuracy", weight: 12 },
  ranking: { label: "Ranking sensibility", weight: 10 },
  classification: { label: "Classification (incl. no-change area)", weight: 15 },
  quote_fidelity: { label: "Quote fidelity", weight: 10 },
  hallucination: { label: "No hallucination", weight: 13 },
  anonymity: { label: "Anonymity", weight: 10 },
  actionability: { label: "Actionability of next steps", weight: 5 },
  executive_summary: { label: "Executive-summary accuracy", weight: 5 },
} as const;
export type CriterionKey = keyof typeof CRITERIA;

/** What the LLM judge returns (validated in judge.ts). */
export interface JudgeVerdict {
  mapping: OpportunityMatch[];
  hallucinations: { claim: string; severity: "major" | "minor"; why: string }[];
  anonymityConcerns: { detail: string; why: string }[];
  actionability: { score: number; evidence: string[] };
  executiveSummary: { score: number; evidence: string[] };
}

export interface GradeInput {
  scenario: Scenario;
  report: BenchReport;
  /** Every participant answer of the run, the only legitimate source of a quote. */
  answers: string[];
  mapping: OpportunityMatch[];
  observed: Observed | null;
  judge: JudgeVerdict | null;
  k: number;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const clamp10 = (x: number): number => Math.max(0, Math.min(10, x));

function byId(report: BenchReport): Map<string, BenchOpportunity> {
  return new Map(report.opportunities.map((o) => [o.id, o]));
}

function titles(ids: string[], opps: Map<string, BenchOpportunity>): string {
  return ids.map((id) => `"${opps.get(id)?.title ?? id}"`).join(", ");
}

export function scoreRecall(input: GradeInput): Criterion {
  const opps = byId(input.report);
  const byProblem = opportunitiesByProblem(input.mapping);
  const kindOf = new Map(input.scenario.problems.map((p) => [p.id, p.kind]));
  const evidence: string[] = [];
  let got = 0;
  let total = 0;
  for (const p of input.scenario.problems.filter((x) => x.kind === "problem")) {
    const obs = observedCount(p, input.observed);
    if (obs === 0) {
      evidence.push(`${p.id}: no interview surfaced it, excluded`);
      continue;
    }
    const w = obs >= 2 ? 1 : 0.5;
    total += w;
    const found = byProblem.get(p.id) ?? [];
    if (!found.length) {
      evidence.push(`${p.id} (${obs} people): MISSED`);
      continue;
    }
    let s = 1;
    const notes: string[] = [];
    if (found.length > 1) {
      // Fragmentation costs more the more pieces a reader has to add up: 2 -> 0.8, 5 -> 0.5.
      s = 1 / (1 + 0.25 * (found.length - 1));
      notes.push(`split across ${found.length} items`);
    }
    const mergedWith = new Set<string>();
    for (const oid of found)
      for (const m of input.mapping.filter((x) => x.opportunityId === oid))
        for (const other of m.problemIds)
          if (other !== p.id && kindOf.get(other) === "problem") mergedWith.add(other);
    if (mergedWith.size) {
      s = Math.min(s, 0.5);
      notes.push(`merged with ${[...mergedWith].join(", ")}`);
    }
    got += w * s;
    evidence.push(
      `${p.id} (${obs} people): found in ${titles(found, opps)}${notes.length ? `; ${notes.join("; ")}` : ""}`,
    );
  }
  return {
    key: "recall",
    ...CRITERIA.recall,
    score: total ? round1((10 * got) / total) : null,
    evidence,
  };
}

export function scorePrevalence(input: GradeInput): Criterion {
  const opps = byId(input.report);
  const byProblem = opportunitiesByProblem(input.mapping);
  const evidence: string[] = [];
  const scores: number[] = [];
  for (const p of input.scenario.problems.filter((x) => x.kind === "problem")) {
    const obs = observedCount(p, input.observed);
    const found = byProblem.get(p.id) ?? [];
    if (!obs || !found.length) continue;
    const counts = found
      .map((id) => opps.get(id)?.participants)
      .filter((c): c is number => typeof c === "number");
    if (!counts.length) {
      scores.push(0);
      evidence.push(`${p.id}: true ${obs}, report gives no count`);
      continue;
    }
    const reported = Math.max(...counts);
    const s = Math.max(0, 1 - Math.abs(reported - obs) / Math.max(obs, 1));
    scores.push(s);
    evidence.push(
      `${p.id}: true ${obs} (planted ${p.plantedIn.length}), reported ${reported}${reported === obs ? "" : " (off)"}`,
    );
  }
  return {
    key: "prevalence",
    ...CRITERIA.prevalence,
    score: scores.length ? round1((10 * scores.reduce((a, b) => a + b, 0)) / scores.length) : null,
    evidence,
  };
}

/** Gain of a planted problem in the ideal ranking: how many raised it plus how much it hurts. */
export function problemGain(p: Problem, observed: Observed | null): number {
  if (p.kind !== "problem") return 0;
  const n = observedCount(p, observed);
  // A problem no interview surfaced cannot be expected in the ranking.
  return n > 0 ? n + p.impact : 0;
}

/**
 * NDCG of the report's order against the ideal order of planted problems. Each problem earns its
 * gain once, at the first position it appears; the works-well area, the distractor and anything not
 * planted earn nothing, so ranking them high pushes real problems down and costs score.
 */
export function scoreRanking(input: GradeInput): Criterion {
  const problems = new Map(input.scenario.problems.map((p) => [p.id, p]));
  const matchOf = new Map(input.mapping.map((m) => [m.opportunityId, m]));
  const ranked = rankedOpportunities(input.report);
  const credited = new Set<string>();
  let dcg = 0;
  const evidence: string[] = [];
  ranked.forEach((o, i) => {
    const m = matchOf.get(o.id);
    let gain = 0;
    let label = m?.kind ?? "unmapped";
    for (const pid of m?.problemIds ?? []) {
      const p = problems.get(pid);
      if (!p) continue;
      label = pid;
      if (p.kind === "problem" && !credited.has(pid)) {
        credited.add(pid);
        gain = problemGain(p, input.observed);
        break;
      }
    }
    dcg += gain / Math.log2(i + 2);
    if (i < 5) evidence.push(`#${i + 1} "${o.title}" (${o.rankScore ?? "no score"}) -> ${label}`);
  });
  const ideal = [...problems.values()]
    .map((p) => problemGain(p, input.observed))
    .filter((g) => g > 0)
    .sort((a, b) => b - a);
  const idcg = ideal.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return {
    key: "ranking",
    ...CRITERIA.ranking,
    score: idcg > 0 && ranked.length ? round1((10 * dcg) / idcg) : null,
    evidence,
  };
}

export function scoreClassification(input: GradeInput): Criterion {
  const opps = byId(input.report);
  const byProblem = opportunitiesByProblem(input.mapping);
  const evidence: string[] = [];
  const points: number[] = [];
  for (const p of input.scenario.problems) {
    const found = byProblem.get(p.id) ?? [];
    const classes = found.map((id) => opps.get(id)?.solutionClass ?? "?");
    const ok = (c: string): boolean => (p.expectedClasses as readonly string[]).includes(c);
    if (p.kind === "distractor") {
      const s = found.length === 0 || classes.every(ok) ? 1 : 0;
      points.push(s);
      evidence.push(
        `${p.id} (distractor): ${found.length ? `raised as ${classes.join("/")}` : "not raised as an item"} -> ${s ? "ok" : "WRONG"}`,
      );
      continue;
    }
    if (observedCount(p, input.observed) === 0) continue;
    if (!found.length) {
      if (p.kind === "works_well") {
        points.push(0);
        evidence.push(`${p.id} (works well): not in the report; expected "${p.expectedClasses.join("/")}"`);
      }
      continue;
    }
    const s = classes.filter(ok).length / classes.length;
    points.push(s);
    evidence.push(
      `${p.id}: ${classes.join("/")} (accept ${p.expectedClasses.join("/")}) -> ${s === 1 ? "ok" : s > 0 ? "partly" : "WRONG"}`,
    );
  }
  return {
    key: "classification",
    ...CRITERIA.classification,
    score: points.length ? round1((10 * points.reduce((a, b) => a + b, 0)) / points.length) : null,
    evidence,
  };
}

export function scoreQuotes(input: GradeInput): Criterion {
  const quotes = extractQuotes(input.report);
  if (!quotes.length)
    return {
      key: "quote_fidelity",
      ...CRITERIA.quote_fidelity,
      score: null,
      evidence: ["the report carries no quotes"],
    };
  const checks = quotes.map((q) => checkQuote(q, input.answers));
  const pts = checks.reduce((s, c) => s + QUOTE_POINTS[c.verdict], 0);
  const bad = checks.filter((c) => c.verdict !== "verbatim");
  return {
    key: "quote_fidelity",
    ...CRITERIA.quote_fidelity,
    score: round1((10 * pts) / checks.length),
    evidence: [
      `${checks.length - bad.length} of ${checks.length} quotes verbatim in a participant answer`,
      ...bad.map(
        (c) => `${c.verdict} (${Math.round(c.coverage * 100)}% of words): "${c.quote.slice(0, 140)}"`,
      ),
    ],
  };
}

export function scoreHallucination(input: GradeInput): Criterion {
  const opps = byId(input.report);
  const unsupported = input.mapping.filter((m) => m.kind === "unsupported");
  if (!input.judge)
    return {
      key: "hallucination",
      ...CRITERIA.hallucination,
      score: null,
      evidence: ["no judge ran; hallucination needs the judge"],
    };
  const major = input.judge.hallucinations.filter((h) => h.severity === "major");
  const minor = input.judge.hallucinations.filter((h) => h.severity === "minor");
  const score = clamp10(10 - hallucinationPenalty(input.judge.hallucinations, unsupported.length));
  return {
    key: "hallucination",
    ...CRITERIA.hallucination,
    score: round1(score),
    evidence: [
      `${unsupported.length} unsupported item(s), ${major.length} major and ${minor.length} minor unsupported claim(s)`,
      ...unsupported.map(
        (m) => `unsupported item "${opps.get(m.opportunityId)?.title ?? m.opportunityId}": ${m.note}`,
      ),
      ...input.judge.hallucinations.map((h) => `${h.severity}: ${h.claim} (${h.why})`),
    ],
  };
}

function wholeWord(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])${esc}($|[^\\p{L}])`, "iu").test(text);
}

export function scoreAnonymity(input: GradeInput): Criterion {
  const text = [
    input.report.markdown,
    ...input.report.opportunities.map(
      (o) => `${o.title}\n${o.summary}\n${o.quotes.join("\n")}\n${o.whyNotAi ?? ""}`,
    ),
  ].join("\n");
  const evidence: string[] = [];
  let penalty = 0;
  for (const p of input.scenario.personas) {
    const parts = [p.name, ...p.name.split(/\s+/)].filter((x) => x.length >= 3);
    const hit = parts.find((n) => wholeWord(text, n));
    if (hit) {
      penalty += 3;
      evidence.push(`name of a participant appears: "${hit}"`);
    }
    for (const id of p.identifiers)
      if (id && text.toLowerCase().includes(id.toLowerCase())) {
        penalty += 2;
        evidence.push(`identifying detail appears: "${id}"`);
      }
  }
  for (const o of input.report.opportunities) {
    if (o.participants === null || o.participants >= input.k) continue;
    const exposed = [
      o.quotes.length ? `${o.quotes.length} quote(s)` : "",
      o.roles.length ? `roles ${o.roles.join(", ")}` : "",
      o.departments.length ? `departments ${o.departments.join(", ")}` : "",
    ].filter(Boolean);
    if (exposed.length) {
      penalty += 3;
      evidence.push(
        `"${o.title}" has ${o.participants} < k=${input.k} participants but exposes ${exposed.join("; ")}`,
      );
    }
  }
  for (const c of input.judge?.anonymityConcerns ?? []) {
    penalty += 1.5;
    evidence.push(`judge: ${c.detail} (${c.why})`);
  }
  if (!evidence.length)
    evidence.push(`no names, identifying details or below-k exposure found (k=${input.k})`);
  return { key: "anonymity", ...CRITERIA.anonymity, score: round1(clamp10(10 - penalty)), evidence };
}

function judged(key: "actionability" | "executive_summary", input: GradeInput): Criterion {
  const v = key === "actionability" ? input.judge?.actionability : input.judge?.executiveSummary;
  return {
    key,
    ...CRITERIA[key],
    score: v ? round1(clamp10(v.score)) : null,
    evidence: v ? v.evidence : ["no judge ran"],
  };
}

export function scoreAll(input: GradeInput): Criterion[] {
  return [
    scoreRecall(input),
    scorePrevalence(input),
    scoreRanking(input),
    scoreClassification(input),
    scoreQuotes(input),
    scoreHallucination(input),
    scoreAnonymity(input),
    judged("actionability", input),
    judged("executive_summary", input),
  ];
}

/** Weighted mean on 0..10 over the criteria that could be measured. */
export function overallScore(criteria: Criterion[]): number {
  let sum = 0;
  let weight = 0;
  for (const c of criteria) {
    if (c.score === null) continue;
    sum += c.score * c.weight;
    weight += c.weight;
  }
  return weight ? round1(sum / weight) : 0;
}

/** Points the hallucination criterion loses: 3 per major claim, 2 per invented item, 0.5 per minor. */
export function hallucinationPenalty(h: JudgeVerdict["hallucinations"], unsupportedItems: number): number {
  const major = h.filter((x) => x.severity === "major").length;
  return 3 * major + 2 * unsupportedItems + 0.5 * (h.length - major);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** The sample whose value is the median (the lower one for an even count), for its evidence. */
function medianSample<T>(samples: T[], value: (s: T) => number): T {
  const sorted = [...samples].sort((a, b) => value(a) - value(b));
  return sorted[Math.floor((sorted.length - 1) / 2)] as T;
}

/**
 * Several judge answers into one: each item's mapping by majority (ties go to the earliest
 * sample), and for the hallucination list, the anonymity concerns and the two narrative scores the
 * median sample, so the evidence printed is one the judge actually gave.
 */
export function aggregateVerdicts(samples: JudgeVerdict[]): JudgeVerdict {
  const first = samples[0];
  if (!first) throw new Error("no judge samples");
  if (samples.length === 1) return first;
  const mapping = first.mapping.map((m) => {
    const votes = new Map<string, { n: number; match: OpportunityMatch }>();
    for (const s of samples) {
      const x = s.mapping.find((y) => y.opportunityId === m.opportunityId) ?? m;
      const key = `${x.kind}:${[...x.problemIds].sort().join("+")}`;
      const v = votes.get(key);
      votes.set(key, { n: (v?.n ?? 0) + 1, match: v?.match ?? x });
    }
    let best = { n: 0, match: m };
    for (const v of votes.values()) if (v.n > best.n) best = v;
    return best.match;
  });
  const unsupportedOf = (s: JudgeVerdict): number => s.mapping.filter((x) => x.kind === "unsupported").length;
  const hall = medianSample(samples, (s) => hallucinationPenalty(s.hallucinations, unsupportedOf(s)));
  const anon = medianSample(samples, (s) => s.anonymityConcerns.length);
  const act = medianSample(samples, (s) => s.actionability.score);
  const exec = medianSample(samples, (s) => s.executiveSummary.score);
  return {
    mapping,
    hallucinations: hall.hallucinations,
    anonymityConcerns: anon.anonymityConcerns,
    actionability: {
      score: median(samples.map((s) => s.actionability.score)),
      evidence: act.actionability.evidence,
    },
    executiveSummary: {
      score: median(samples.map((s) => s.executiveSummary.score)),
      evidence: exec.executiveSummary.evidence,
    },
  };
}

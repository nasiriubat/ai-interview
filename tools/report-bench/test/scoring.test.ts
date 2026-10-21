import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateCost } from "../src/estimate.js";
import { grade } from "../src/grade/index.js";
import {
  keywordHits,
  keywordMapping,
  mappingAgreement,
  type Observed,
  type OpportunityMatch,
} from "../src/grade/match.js";
import { compareScorecards, renderScorecard } from "../src/grade/scorecard.js";
import {
  aggregateVerdicts,
  hallucinationPenalty,
  overallScore,
  scoreAnonymity,
  scoreClassification,
  scorePrevalence,
  scoreQuotes,
  scoreRanking,
  scoreRecall,
  type Criterion,
  type GradeInput,
  type JudgeVerdict,
} from "../src/grade/scoring.js";
import { fromAnalysisDetail, type BenchOpportunity, type BenchReport } from "../src/report.js";
import { loadScenario, parseScenario } from "../src/scenario.js";
import { participantText, seedFor, type Transcript } from "../src/simulate.js";

const here = import.meta.dirname;
const scenario = loadScenario(join(here, "../scenarios/kaarna-logistics.json"));
const transcripts = JSON.parse(readFileSync(join(here, "fixtures/transcripts.json"), "utf8")) as Transcript[];
const detail = JSON.parse(readFileSync(join(here, "fixtures/analysis-detail.json"), "utf8")) as unknown;
const report = fromAnalysisDetail(detail, "fixture", 3);

/** Observed prevalence equal to the planted one, so expectations read straight off the scenario. */
const planted: Observed = Object.fromEntries(scenario.problems.map((p) => [p.id, p.plantedIn]));

function opp(id: string, extra: Partial<BenchOpportunity> = {}): BenchOpportunity {
  return {
    id,
    title: id,
    summary: "",
    solutionClass: "automation",
    rankScore: null,
    participants: null,
    roles: [],
    departments: [],
    quotes: [],
    whyNotAi: null,
    ...extra,
  };
}
function match(opportunityId: string, ...problemIds: string[]): OpportunityMatch {
  return { opportunityId, kind: problemIds.length ? "planted" : "other_supported", problemIds, note: "" };
}
function input(
  r: Partial<BenchReport>,
  mapping: OpportunityMatch[],
  extra: Partial<GradeInput> = {},
): GradeInput {
  return {
    scenario,
    report: { source: "t", markdown: "", k: 3, opportunities: [], ...r },
    answers: transcripts.flatMap(participantText),
    mapping,
    observed: planted,
    judge: null,
    k: 3,
    ...extra,
  };
}

/** A report that gets every planted item exactly right, in the ideal order. */
const perfectOpps = [
  opp("inv", { solutionClass: "automation", rankScore: 90, participants: 5 }),
  opp("appr", { solutionClass: "process", rankScore: 80, participants: 4 }),
  opp("hand", { solutionClass: "software", rankScore: 70, participants: 3 }),
  opp("calls", { solutionClass: "software", rankScore: 60, participants: 2 }),
  opp("tacho", { solutionClass: "automation", rankScore: 50, participants: 1 }),
  opp("pod", { solutionClass: "none", rankScore: 10, participants: 3 }),
];
const perfectMap = [
  match("inv", "invoice_rekeying"),
  match("appr", "approval_delays"),
  match("hand", "shift_handover_paper"),
  match("calls", "shipment_status_calls"),
  match("tacho", "tachograph_compliance"),
  match("pod", "pod_app_works"),
];

describe("scenario", () => {
  it("the shipped scenario is valid and plants the prevalences the README promises", () => {
    const count = (id: string): number => scenario.problems.find((p) => p.id === id)?.plantedIn.length ?? 0;
    expect(scenario.personas).toHaveLength(10);
    expect(new Set(scenario.personas.map((p) => p.department)).size).toBe(3);
    expect([
      count("invoice_rekeying"),
      count("approval_delays"),
      count("shift_handover_paper"),
      count("tachograph_compliance"),
    ]).toEqual([5, 4, 3, 1]);
    expect(scenario.personas.some((p) => p.language === "fi")).toBe(true);
  });

  it("refuses a problem planted in a persona that does not exist", () => {
    const raw = JSON.parse(readFileSync(join(here, "../scenarios/kaarna-logistics.json"), "utf8")) as {
      problems: { plantedIn: string[] }[];
    };
    raw.problems[0]?.plantedIn.push("nobody");
    expect(() => parseScenario(raw)).toThrow(/unknown persona nobody/);
  });
});

describe("keyword mapping", () => {
  it("counts distinct keywords at word starts and maps the fixture items", () => {
    const p = scenario.problems.find((x) => x.id === "invoice_rekeying");
    expect(p && keywordHits(p, "PDF invoices are retyped into Procountor")).toBe(4);
    const m = keywordMapping(scenario, report.opportunities);
    expect(m.map((x) => x.problemIds[0] ?? "-")).toEqual([
      "invoice_rekeying",
      "approval_delays",
      "pod_app_works",
      "tachograph_compliance",
    ]);
    expect(mappingAgreement(m, m)).toBe(1);
    expect(mappingAgreement(m, [match("o1", "approval_delays")])).toBe(0);
  });
});

describe("recall", () => {
  it("is 10 when every planted problem is found once", () => {
    expect(scoreRecall(input({ opportunities: perfectOpps }, perfectMap)).score).toBe(10);
  });

  it("weights a one-person problem at half and penalises a miss, a split and a merge", () => {
    // Missing the one-person problem: 4 of 4.5 weight.
    const missTacho = perfectMap.filter((m) => m.opportunityId !== "tacho");
    expect(scoreRecall(input({ opportunities: perfectOpps }, missTacho)).score).toBe(8.9);
    // Invoice re-keying split in two (0.8) and handover merged into approvals (0.5 each).
    const messy = [
      match("inv", "invoice_rekeying"),
      match("inv2", "invoice_rekeying"),
      match("appr", "approval_delays", "shift_handover_paper"),
      match("calls", "shipment_status_calls"),
      match("tacho", "tachograph_compliance"),
    ];
    const r = scoreRecall(input({ opportunities: perfectOpps }, messy));
    expect(r.score).toBe(Math.round(((10 * (0.8 + 0.5 + 0.5 + 1 + 0.5)) / 4.5) * 10) / 10);
    expect(r.evidence.join("\n")).toMatch(/split across 2 items/);
    expect(r.evidence.join("\n")).toMatch(/merged with shift_handover_paper/);
  });

  it("leaves out a problem no interview surfaced", () => {
    const observed: Observed = { ...planted, tachograph_compliance: [] };
    const missTacho = perfectMap.filter((m) => m.opportunityId !== "tacho");
    expect(scoreRecall(input({ opportunities: perfectOpps }, missTacho, { observed })).score).toBe(10);
  });
});

describe("prevalence", () => {
  it("is 10 for exact counts and loses the relative error otherwise", () => {
    expect(scorePrevalence(input({ opportunities: perfectOpps }, perfectMap)).score).toBe(10);
    const off = perfectOpps.map((o) => (o.id === "inv" ? { ...o, participants: 3 } : o));
    // invoice: 1 - 2/5 = 0.6; the other four exact.
    expect(scorePrevalence(input({ opportunities: off }, perfectMap)).score).toBe(9.2);
  });

  it("scores a found problem with no count as zero", () => {
    const none = perfectOpps.map((o) => ({ ...o, participants: null }));
    expect(scorePrevalence(input({ opportunities: none }, perfectMap)).score).toBe(0);
  });
});

describe("ranking", () => {
  it("is 10 in the ideal order and lower when the works-well area leads", () => {
    expect(scoreRanking(input({ opportunities: perfectOpps }, perfectMap)).score).toBe(10);
    const podFirst = perfectOpps.map((o) => (o.id === "pod" ? { ...o, rankScore: 99 } : o));
    const s = scoreRanking(input({ opportunities: podFirst }, perfectMap)).score ?? 0;
    expect(s).toBeLessThan(10);
    expect(s).toBeGreaterThan(5);
  });
});

describe("ranking with nothing to rank", () => {
  it("is n/a when no planted problem was surfaced", () => {
    const observed: Observed = Object.fromEntries(scenario.problems.map((p) => [p.id, []]));
    expect(scoreRanking(input({ opportunities: perfectOpps }, perfectMap, { observed })).score).toBeNull();
  });
});

describe("classification", () => {
  it("accepts the expected classes, rewards a distractor left out, and fails a missing works-well area", () => {
    expect(scoreClassification(input({ opportunities: perfectOpps }, perfectMap)).score).toBe(10);
    const noPod = perfectMap.filter((m) => m.opportunityId !== "pod");
    const c = scoreClassification(input({ opportunities: perfectOpps }, noPod));
    // Five problems right, distractor right, works-well missing: 6 of 7.
    expect(c.score).toBe(8.6);
    const aiDistractor = [...perfectMap, match("ai", "ai_everything")];
    const withAi = [...perfectOpps, opp("ai", { solutionClass: "ai" })];
    expect(scoreClassification(input({ opportunities: withAi }, aiDistractor)).evidence.join("\n")).toMatch(
      /distractor.*WRONG/,
    );
  });
});

describe("quotes and anonymity on the fixture", () => {
  it("finds the invented quote and the leaked name and the below-k role", () => {
    const base = input(report, keywordMapping(scenario, report.opportunities));
    const q = scoreQuotes(base);
    // Two verbatim, one invented: 2 of 3.
    expect(q.score).toBe(6.7);
    expect(q.evidence.join("\n")).toMatch(/not_found.*chatbot/);
    const a = scoreAnonymity(base);
    expect(a.evidence.join("\n")).toMatch(/Anna Lindqvist/);
    expect(a.evidence.join("\n")).toMatch(/Tachograph.*1 < k=3.*roles Payroll/);
    expect(a.score).toBe(4);
  });

  it("gives n/a when the report has no quotes", () => {
    expect(scoreQuotes(input({ opportunities: perfectOpps }, perfectMap)).score).toBeNull();
  });
});

describe("scorecard math", () => {
  it("averages by weight over the measured criteria only", () => {
    const c = (score: number | null, weight: number): Criterion => ({
      key: "recall",
      label: "x",
      weight,
      score,
      evidence: [],
    });
    expect(overallScore([c(10, 20), c(5, 10), c(null, 50)])).toBe(8.3);
    expect(overallScore([c(null, 10)])).toBe(0);
  });

  it("grades the fixture end to end without a judge or the network, renders and compares", async () => {
    const card = await grade({ scenario, run: "fixture", report, transcripts, judge: null });
    expect(card.mappingSource).toBe("keywords");
    expect(card.criteria.find((x) => x.key === "hallucination")?.score).toBeNull();
    expect(card.notes.join()).toMatch(/sari_terminal \(turn cap reached\)/);
    const md = renderScorecard(card);
    expect(md).toMatch(/## Overall: \d+\.\d \/ 10/);
    const better = { ...card, run: "after", overall: card.overall + 1 };
    expect(compareScorecards(card, better)).toMatch(/\| \*\*Overall\*\* .*\*\*\+1\.0\*\*/);
  });
});

describe("estimate", () => {
  const price = { inputPerMtok: 1, outputPerMtok: 5 };
  it("grows with personas and leaves out parts without a price", () => {
    const a = estimateCost({
      personas: 5,
      turns: 10,
      interview: price,
      extraction: price,
      analysis: price,
      simulator: price,
      judge: price,
    });
    const b = estimateCost({
      personas: 10,
      turns: 10,
      interview: price,
      extraction: price,
      analysis: price,
      simulator: price,
      judge: price,
    });
    expect(b.totalUsd).toBeGreaterThan(a.totalUsd);
    const judgeOnly = estimateCost({
      personas: 10,
      turns: 10,
      interview: null,
      extraction: null,
      analysis: null,
      simulator: null,
      judge: price,
    });
    expect(judgeOnly.lines.map((l) => l.part)).toEqual(["judge and observation (harness)"]);
  });
});

describe("seeds", () => {
  it("are stable and differ per persona and turn", () => {
    expect(seedFor(7, "anna_ap", 0)).toBe(seedFor(7, "anna_ap", 0));
    expect(seedFor(7, "anna_ap", 0)).not.toBe(seedFor(7, "anna_ap", 1));
    expect(seedFor(7, "anna_ap", 0)).not.toBe(seedFor(8, "anna_ap", 0));
  });
});

describe("judge aggregation", () => {
  const verdict = (ids: string[], minors: number, act: number): JudgeVerdict => ({
    mapping: [match("inv", ...ids)],
    hallucinations: Array.from({ length: minors }, (_, i) => ({
      claim: `c${i}`,
      severity: "minor" as const,
      why: "",
    })),
    anonymityConcerns: [],
    actionability: { score: act, evidence: [`act ${act}`] },
    executiveSummary: { score: act, evidence: [] },
  });

  it("takes the majority mapping and the median sample's findings and scores", () => {
    const agg = aggregateVerdicts([
      verdict(["invoice_rekeying"], 6, 4),
      verdict(["approval_delays"], 0, 8),
      verdict(["invoice_rekeying"], 2, 7),
    ]);
    expect(agg.mapping[0]?.problemIds).toEqual(["invoice_rekeying"]);
    expect(agg.hallucinations).toHaveLength(2);
    expect(agg.actionability).toEqual({ score: 7, evidence: ["act 7"] });
  });

  it("weighs the penalty: 3 per major, 2 per invented item, 0.5 per minor", () => {
    const h = [
      { claim: "a", severity: "major" as const, why: "" },
      { claim: "b", severity: "minor" as const, why: "" },
    ];
    expect(hallucinationPenalty(h, 2)).toBe(7.5);
  });
});

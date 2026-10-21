import type { BenchReport } from "../report.js";
import type { Scenario } from "../scenario.js";
import {
  mappingAgreement,
  observedCount,
  opportunitiesByProblem,
  type Observed,
  type OpportunityMatch,
} from "./match.js";
import { overallScore, type Criterion, type CriterionKey } from "./scoring.js";

export interface ProblemRow {
  id: string;
  kind: string;
  planted: number;
  observed: number;
  foundIn: string[];
  reportedParticipants: number | null;
  classes: string[];
}

export interface Scorecard {
  scenario: { id: string; version: number };
  run: string;
  gradedAt: string;
  reportSource: string;
  judgeModel: string | null;
  mappingSource: "judge" | "keywords";
  /** Share of report items on which the judge and the keyword cross-check agree, 0..1. */
  keywordAgreement: number | null;
  overall: number;
  criteria: Criterion[];
  problems: ProblemRow[];
  items: {
    title: string;
    solutionClass: string;
    rankScore: number | null;
    participants: number | null;
    mappedTo: string;
  }[];
  spend: Record<string, number> | null;
  notes: string[];
}

export function buildScorecard(args: {
  scenario: Scenario;
  run: string;
  report: BenchReport;
  criteria: Criterion[];
  mapping: OpportunityMatch[];
  keywordMapping: OpportunityMatch[];
  mappingSource: "judge" | "keywords";
  observed: Observed | null;
  judgeModel: string | null;
  spend: Record<string, number> | null;
  notes: string[];
  now?: Date;
}): Scorecard {
  const byProblem = opportunitiesByProblem(args.mapping);
  const opps = new Map(args.report.opportunities.map((o) => [o.id, o]));
  const matchOf = new Map(args.mapping.map((m) => [m.opportunityId, m]));
  return {
    scenario: { id: args.scenario.id, version: args.scenario.version },
    run: args.run,
    gradedAt: (args.now ?? new Date()).toISOString(),
    reportSource: args.report.source,
    judgeModel: args.judgeModel,
    mappingSource: args.mappingSource,
    keywordAgreement:
      args.mappingSource === "judge"
        ? Math.round(mappingAgreement(args.mapping, args.keywordMapping) * 100) / 100
        : null,
    overall: overallScore(args.criteria),
    criteria: args.criteria,
    problems: args.scenario.problems.map((p) => {
      const ids = byProblem.get(p.id) ?? [];
      const counts = ids
        .map((id) => opps.get(id)?.participants)
        .filter((c): c is number => typeof c === "number");
      return {
        id: p.id,
        kind: p.kind,
        planted: p.plantedIn.length,
        observed: observedCount(p, args.observed),
        foundIn: ids.map((id) => opps.get(id)?.title ?? id),
        reportedParticipants: counts.length ? Math.max(...counts) : null,
        classes: ids.map((id) => opps.get(id)?.solutionClass ?? "?"),
      };
    }),
    items: args.report.opportunities.map((o) => {
      const m = matchOf.get(o.id);
      return {
        title: o.title,
        solutionClass: o.solutionClass,
        rankScore: o.rankScore,
        participants: o.participants,
        mappedTo: m ? (m.problemIds.length ? m.problemIds.join("+") : m.kind) : "unmapped",
      };
    }),
    spend: args.spend,
    notes: args.notes,
  };
}

const fmt = (x: number | null): string => (x === null ? "n/a" : x.toFixed(1));

export function renderScorecard(card: Scorecard): string {
  const out = [
    `# Report bench scorecard: ${card.run}`,
    "",
    `Scenario \`${card.scenario.id}\` v${card.scenario.version}; graded ${card.gradedAt.slice(0, 16).replace("T", " ")} UTC; report ${card.reportSource}.`,
    `Judge: ${card.judgeModel ?? "none"}; mapping from ${card.mappingSource}${card.keywordAgreement !== null ? ` (keyword cross-check agrees on ${Math.round(card.keywordAgreement * 100)}% of items)` : ""}.`,
    "",
    `## Overall: ${card.overall.toFixed(1)} / 10`,
    "",
    "| Criterion | Weight | Score |",
    "|---|---|---|",
    ...card.criteria.map((c) => `| ${c.label} | ${c.weight} | ${fmt(c.score)} |`),
    "",
    "## Ground truth against the report",
    "",
    "| Item | Kind | Planted | Observed | Found as | Reported count | Class |",
    "|---|---|---|---|---|---|---|",
    ...card.problems.map(
      (p) =>
        `| ${p.id} | ${p.kind} | ${p.planted} | ${p.observed} | ${p.foundIn.length ? p.foundIn.map((t) => t.replaceAll("|", "/")).join("; ") : "-"} | ${p.reportedParticipants ?? "-"} | ${p.classes.join("/") || "-"} |`,
    ),
    "",
    "## Report items",
    "",
    "| Title | Class | Rank | Participants | Mapped to |",
    "|---|---|---|---|---|",
    ...card.items.map(
      (i) =>
        `| ${i.title.replaceAll("|", "/")} | ${i.solutionClass} | ${i.rankScore ?? "-"} | ${i.participants ?? "-"} | ${i.mappedTo} |`,
    ),
    "",
    "## Evidence",
    "",
  ];
  for (const c of card.criteria) {
    out.push(`### ${c.label}: ${fmt(c.score)}`, "", ...c.evidence.map((e) => `- ${e}`), "");
  }
  if (card.spend) {
    out.push(
      "## Spend (USD)",
      "",
      ...Object.entries(card.spend).map(([k, v]) => `- ${k}: ${v.toFixed(3)}`),
      "",
    );
  }
  if (card.notes.length) out.push("## Notes", "", ...card.notes.map((n) => `- ${n}`), "");
  return out.join("\n");
}

/** Side-by-side of two scorecards: per criterion, the overall, and which planted items changed. */
export function compareScorecards(a: Scorecard, b: Scorecard): string {
  const delta = (x: number | null, y: number | null): string =>
    x === null || y === null ? "" : `${y - x >= 0 ? "+" : ""}${(y - x).toFixed(1)}`;
  const byKey = new Map<CriterionKey, Criterion>(b.criteria.map((c) => [c.key, c]));
  const out = [
    `# Compare: ${a.run} -> ${b.run}`,
    "",
    "| Criterion | A | B | Delta |",
    "|---|---|---|---|",
    ...a.criteria.map((c) => {
      const other = byKey.get(c.key)?.score ?? null;
      return `| ${c.label} | ${fmt(c.score)} | ${fmt(other)} | ${delta(c.score, other)} |`;
    }),
    `| **Overall** | **${a.overall.toFixed(1)}** | **${b.overall.toFixed(1)}** | **${delta(a.overall, b.overall)}** |`,
    "",
    "| Planted item | A found as | B found as | A count | B count |",
    "|---|---|---|---|---|",
  ];
  const bp = new Map(b.problems.map((p) => [p.id, p]));
  for (const p of a.problems) {
    const q = bp.get(p.id);
    out.push(
      `| ${p.id} | ${p.foundIn.length ? `${p.foundIn.length} item(s), ${p.classes.join("/")}` : "missed"} | ${q?.foundIn.length ? `${q.foundIn.length} item(s), ${q.classes.join("/")}` : "missed"} | ${p.reportedParticipants ?? "-"} | ${q?.reportedParticipants ?? "-"} |`,
    );
  }
  out.push("", `Items in the report: A ${a.items.length}, B ${b.items.length}.`);
  return out.join("\n");
}

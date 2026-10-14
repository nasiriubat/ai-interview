import type { ClusterStats, DepartmentComparison, Factors, ReportSection, SolutionClass } from "@aidp/shared";
import { FACTOR_KEYS, isNotAi } from "@aidp/shared";

export interface ReportOpportunity {
  clusterKey: string;
  title: string;
  summary: string;
  solutionClass: SolutionClass;
  rankScore: number;
  factors: Factors;
  stats: ClusterStats;
  whyNotAi?: string | undefined;
  processes: { name: string; steps: string[] }[];
}

export interface ReportInput {
  campaignName: string;
  generatedAt: Date;
  participation: {
    invited: number;
    completed: number;
    sessionsAnalyzed: number;
    facts: number;
    thresholdMet: boolean;
  };
  opportunities: ReportOpportunity[];
  narrative: { executiveSummary: string; nextSteps: string[]; caveats: string };
  sections: ReportSection[];
  k: number;
  language: string;
  /** Present when the comparison was computed; the section says why when it was not shown. */
  departments?: DepartmentComparison | undefined;
}

const CLASS_LABEL: Record<SolutionClass, string> = {
  ai: "AI",
  automation: "Automation",
  software: "Software",
  process: "Process",
  none: "No change recommended",
};
const FACTOR_LABEL: Record<(typeof FACTOR_KEYS)[number], string> = {
  expected_impact: "Impact",
  affected_employees: "People",
  frequency: "Frequency",
  implementation_complexity: "Simplicity",
  data_availability: "Data",
  risk: "Low risk",
  ai_suitability: "AI fit",
};

/** Deterministic Markdown with Mermaid process maps (spec 04, FR-17a). Narrative pieces come from the model. */
export function renderReport(input: ReportInput): string {
  const on = (s: ReportSection): boolean => input.sections.includes(s);
  const ranked = [...input.opportunities].sort((a, b) => b.rankScore - a.rankScore);
  const out: string[] = [
    `# Discovery report: ${input.campaignName}`,
    "",
    `Generated ${input.generatedAt.toISOString().slice(0, 10)}${input.participation.thresholdMet ? "" : " (preliminary: below the completion threshold)"}.`,
    "",
  ];

  if (on("executive_summary")) out.push("## Executive summary", "", input.narrative.executiveSummary, "");

  if (on("participation")) {
    const p = input.participation;
    out.push(
      "## Participation and method",
      "",
      `| Invited | Completed interviews | Interviews analyzed | Facts extracted |`,
      `|---|---|---|---|`,
      `| ${p.invited} | ${p.completed} | ${p.sessionsAnalyzed} | ${p.facts} |`,
      "",
      `Quotes and breakdowns appear only where at least ${input.k} participants are behind them. Durations are self-reported.`,
      "",
      input.narrative.caveats,
      "",
    );
  }

  if (on("work_map")) {
    out.push("## Work map", "", "Clusters of activity by share of participants who described them.", "");
    for (const o of ranked) {
      out.push(
        `### ${o.title}`,
        "",
        `${o.stats.participants} participant${o.stats.participants === 1 ? "" : "s"}${o.stats.minutesPerWeekTotal ? `, about ${Math.round(o.stats.minutesPerWeekTotal / 60)} hours per week in total` : ""}${o.stats.tools.length ? `, tools: ${o.stats.tools.join(", ")}` : ""}.${o.stats.participants < input.k ? ` Fewer than ${input.k} participants described this, so quotes, roles, tools and process maps are withheld.` : ""}`,
        "",
      );
      for (const proc of o.processes.slice(0, 2)) out.push(processMap(proc), "");
    }
  }

  if (on("department_comparison")) out.push(...departmentSection(input.departments, input.k));

  if (on("opportunities")) {
    out.push("## Opportunities by solution class", "");
    for (const cls of ["ai", "automation", "software", "process"] as const) {
      const items = ranked.filter((o) => o.solutionClass === cls);
      if (!items.length) continue;
      out.push(
        `### ${CLASS_LABEL[cls]}`,
        "",
        `| Rank | Opportunity | ${FACTOR_KEYS.map((k) => FACTOR_LABEL[k]).join(" | ")} |`,
        `|---|---|${FACTOR_KEYS.map(() => "---").join("|")}|`,
      );
      for (const o of items)
        out.push(
          `| ${o.rankScore} | ${o.title} | ${FACTOR_KEYS.map((k) => o.factors[k].score).join(" | ")} |`,
        );
      out.push("");
      for (const o of items) {
        out.push(`**${o.title}.** ${o.summary}`);
        if (o.stats.quotes.length) out.push("", ...o.stats.quotes.slice(0, 3).map((q) => `> ${q}`));
        out.push("");
      }
    }
  }

  if (on("quick_wins_vs_strategic")) {
    const quick = ranked.filter(
      (o) =>
        o.solutionClass !== "none" &&
        o.factors.implementation_complexity.score >= 4 &&
        o.factors.expected_impact.score >= 3,
    );
    const strategic = ranked.filter(
      (o) =>
        o.solutionClass !== "none" &&
        o.factors.expected_impact.score >= 4 &&
        o.factors.implementation_complexity.score <= 3,
    );
    out.push(
      "## Quick wins and strategic bets",
      "",
      "**Quick wins** (high simplicity, real impact):",
      "",
      ...(quick.length ? quick.map((o) => `- ${o.title} (rank ${o.rankScore})`) : ["- none identified"]),
      "",
      "**Strategic bets** (high impact, larger effort):",
      "",
      ...(strategic.length
        ? strategic.map((o) => `- ${o.title} (rank ${o.rankScore})`)
        : ["- none identified"]),
      "",
    );
  }

  if (on("not_ai")) {
    const notAi = ranked.filter((o) => isNotAi(o.solutionClass));
    out.push("## Where AI is not the answer", "");
    out.push(
      ...(notAi.length
        ? notAi.map((o) => `- **${o.title}** (${CLASS_LABEL[o.solutionClass]}): ${o.whyNotAi ?? o.summary}`)
        : ["Every cluster has a technical solution class; nothing was ruled out."]),
      "",
    );
  }

  if (on("next_steps")) {
    out.push(
      "## Recommended next steps",
      "",
      ...input.narrative.nextSteps.map((s, i) => `${i + 1}. ${s}`),
      "",
    );
  }
  return out.join("\n");
}

/** A left-to-right Mermaid flowchart of a described process. Labels are quoted so punctuation is safe. */
export function processMap(proc: { name: string; steps: string[] }): string {
  const q = (s: string): string => `"${s.replace(/"/g, "'").slice(0, 60)}"`;
  const nodes = proc.steps.slice(0, 8).map((s, i) => `  s${i}[${q(s)}]`);
  const edges = proc.steps
    .slice(0, 8)
    .map((_, i) => (i ? `  s${i - 1} --> s${i}` : ""))
    .filter(Boolean);
  return [
    "```mermaid",
    "flowchart LR",
    `  subgraph ${q(proc.name)}`,
    ...nodes,
    ...edges,
    "  end",
    "```",
  ].join("\n");
}

const NOT_SHOWN: Record<string, string> = {
  disabled: "The department comparison is turned off for this campaign.",
  no_departments: "Participants did not give a department, so there is nothing to compare.",
  too_few_eligible:
    "Fewer than two groups have enough participants to be compared without singling anyone out.",
};

const COMPARED_CLASSES = ["ai", "automation", "software", "process"] as const;

/**
 * Always exactly one `##` heading when the section is on: the web client maps the n-th heading to
 * the n-th enabled section, so a section that vanished would shift every one after it.
 */
function departmentSection(d: DepartmentComparison | undefined, k: number): string[] {
  const out = ["## Department comparison", ""];
  if (!d?.shown) {
    out.push(
      `Not shown. ${NOT_SHOWN[d?.reason ?? "too_few_eligible"] ?? ""} A department needs at least ${k} participants.`,
      "",
    );
    return out;
  }
  const pct = (x: number | undefined): string => (x === undefined ? "withheld" : `${Math.round(x * 100)}%`);
  out.push(
    `Each group below has at least ${k} participants. Shares are of the group's own participants.`,
    "",
    `| Group | Participants | Hours per week | ${COMPARED_CLASSES.map((c) => CLASS_LABEL[c]).join(" | ")} | Most shared |`,
    `|---|---|---|${COMPARED_CLASSES.map(() => "---").join("|")}|---|`,
  );
  for (const row of d.departments) {
    const name = row.kind === "other" ? "Other departments" : (row.name ?? "Unspecified");
    const top =
      row.topOpportunities.map((t) => `${t.title} (${pct(t.share)})`).join("; ") ||
      "none shared by enough people";
    out.push(
      `| ${name} | ${row.participants} | ${Math.round(row.minutesPerWeek / 60)} | ${COMPARED_CLASSES.map((c) => pct(row.solutionClassShare[c])).join(" | ")} | ${top} |`,
    );
  }
  out.push("");
  if (d.belowK > 0)
    out.push(
      `${d.belowK} department${d.belowK === 1 ? "" : "s"} with fewer than ${k} participants ${d.belowK === 1 ? "is" : "are"} not shown by name.`,
      "",
    );
  return out;
}

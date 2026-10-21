import type {
  ClusterStats,
  DepartmentComparison,
  Factors,
  ReportSection,
  SolutionClass,
  VerificationStats,
} from "@aidp/shared";
import { FACTOR_KEYS, interviewsOf, isNotAi } from "@aidp/shared";

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
    /** Interviews begun, completed or not; printed next to the completed count when known. */
    started?: number | undefined;
    /** The campaign's completion threshold, for the small-sample note when it is not met. */
    needed?: number | undefined;
  };
  opportunities: ReportOpportunity[];
  narrative: { executiveSummary: string; nextSteps: string[]; caveats: string };
  sections: ReportSection[];
  k: number;
  language: string;
  /** Present when the comparison was computed; the section says why when it was not shown. */
  departments?: DepartmentComparison | undefined;
  /**
   * What this report was made from, printed on the cover so a reader can tell whether two reports
   * are comparable. Every field is optional: a caller that does not know a value leaves it out and
   * the cover says nothing about it rather than guessing.
   */
  provenance?: ReportProvenance | undefined;
  /** A group mentioned in this many interviews or fewer is marked as a small sample (default 2). */
  smallSample?: number | undefined;
  /** What the evidence check removed, stated in the method note (D-478). */
  verification?: VerificationStats | undefined;
}

export const DEFAULT_SMALL_SAMPLE = 2;

/** "Mentioned in 3 of 12 interviews": distinct interviews, never how often it was said. */
export function mentionedIn(stats: ClusterStats, total: number): string {
  return `Mentioned in ${interviewsOf(stats)} of ${total} interview${total === 1 ? "" : "s"}`;
}

/** The calm note for a group that rests on one or two interviews; empty when it does not. */
export function smallSampleNote(stats: ClusterStats, smallSample = DEFAULT_SMALL_SAMPLE): string {
  const n = interviewsOf(stats);
  if (n > smallSample) return "";
  return `Small sample: this rests on ${n === 1 ? "one interview" : `${n} interviews`}, so treat it as a lead to check rather than a finding.`;
}

export interface ReportProvenance {
  templateKey?: string | undefined;
  templateVersion?: number | undefined;
  /** Prompt version tags such as `clustering@p2`, one per prompt used by the analysis. */
  promptVersions?: string[] | undefined;
  /** `balanced`, `quick_wins`, `strategic` or `custom`. */
  weightsPreset?: string | undefined;
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
  const total = input.participation.sessionsAnalyzed;
  const small = (o: ReportOpportunity): string => {
    const note = smallSampleNote(o.stats, input.smallSample);
    return note ? ` ${note}` : "";
  };
  const ranked = [...input.opportunities].sort((a, b) => b.rankScore - a.rankScore);
  const out: string[] = [
    `# Discovery report: ${input.campaignName}`,
    "",
    `Generated ${input.generatedAt.toISOString().slice(0, 10)}${input.participation.thresholdMet ? "" : " (preliminary: below the completion threshold)"}.`,
    "",
    ...cover(input),
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
        `${mentionedIn(o.stats, input.participation.sessionsAnalyzed)} (${o.stats.participants} participant${o.stats.participants === 1 ? "" : "s"})${o.stats.minutesPerWeekTotal ? `, about ${Math.round(o.stats.minutesPerWeekTotal / 60)} hours per week in total as they described it` : ""}${o.stats.tools.length ? `, tools: ${o.stats.tools.join(", ")}` : ""}.${o.stats.participants < input.k ? ` Fewer than ${input.k} participants described this, so quotes, roles, tools and process maps are withheld.` : ""}${small(o)}`,
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
        `| Rank | Opportunity | Interviews | ${FACTOR_KEYS.map((k) => FACTOR_LABEL[k]).join(" | ")} |`,
        `|---|---|---|${FACTOR_KEYS.map(() => "---").join("|")}|`,
      );
      for (const o of items)
        out.push(
          `| ${o.rankScore} | ${o.title} | ${interviewsOf(o.stats)} of ${total} | ${FACTOR_KEYS.map((k) => o.factors[k].score).join(" | ")} |`,
        );
      out.push("");
      for (const o of items) {
        out.push(`**${o.title}.** ${o.summary}`, "", `*${mentionedIn(o.stats, total)}.${small(o)}*`);
        // One blockquote per quote: consecutive "> " lines would run three people's words together.
        if (o.stats.quotes.length) out.push(...o.stats.quotes.slice(0, 3).flatMap((q) => ["", `> ${q}`]));
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
      ...(quick.length
        ? quick.map(
            (o) => `- ${o.title} (rank ${o.rankScore}; ${interviewsOf(o.stats)} of ${total} interviews)`,
          )
        : ["- none identified"]),
      "",
      "**Strategic bets** (high impact, larger effort):",
      "",
      ...(strategic.length
        ? strategic.map(
            (o) => `- ${o.title} (rank ${o.rankScore}; ${interviewsOf(o.stats)} of ${total} interviews)`,
          )
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

/**
 * The cover block: how the report was made, what it does not do, and what to quote to reproduce
 * it. It is plain paragraphs with no `##` heading on purpose. The web client maps the n-th level-2
 * heading to the n-th enabled section, and the cover is preface content that must not shift that
 * mapping (it also stays visible when every section is switched off).
 */
export function cover(input: ReportInput): string[] {
  const p = input.participation;
  const who =
    p.invited >= p.completed && p.invited > 0
      ? `${p.completed} of ${p.invited} invited people completed`
      : `${p.completed} ${p.completed === 1 ? "person" : "people"} completed`;
  const started = p.started !== undefined && p.started > p.sessionsAnalyzed ? ` (${p.started} started)` : "";
  const out = [
    `**Based on ${p.sessionsAnalyzed} completed interview${p.sessionsAnalyzed === 1 ? "" : "s"}${started}.**`,
    "",
  ];
  if (!p.thresholdMet)
    out.push(
      `**Small sample.** ${p.needed !== undefined && p.needed > p.sessionsAnalyzed ? `The campaign set ${p.needed} completed interviews as the point where results are representative, and this report has ${p.sessionsAnalyzed}.` : "The campaign has not reached its completion threshold yet."} Read the patterns below as early signals; they can change as more people take part.`,
      "",
    );
  out.push(
    `**Method.** ${who} a structured interview about how their work is done; ${p.sessionsAnalyzed} ${p.sessionsAnalyzed === 1 ? "interview was" : "interviews were"} analyzed. Everyone followed the same template and was asked one question at a time. Facts were extracted on a fixed schema, grouped across all interviews and scored on seven factors. Durations are self-reported.`,
    "",
    `**What this report does not do.** It does not name or attribute anything to an individual: a quote, a role or a department appears only when at least ${input.k} participants are behind it. It does not assume AI is the answer: each opportunity is classified as AI, automation, software, process or no change recommended, with the reason.`,
    "",
    `**How to read the evidence.** ${evidenceNote(input)}`,
    "",
  );
  const v = input.provenance;
  if (v) {
    const parts: string[] = [];
    if (v.templateKey)
      parts.push(`template ${v.templateKey}${v.templateVersion ? ` v${v.templateVersion}` : ""}`);
    if (v.promptVersions?.length) parts.push(`prompts ${[...v.promptVersions].sort().join(", ")}`);
    if (v.weightsPreset) parts.push(`weights preset ${v.weightsPreset}`);
    if (parts.length) out.push(`**Reproducibility.** ${parts.join("; ")}.`, "");
  }
  return out;
}

/**
 * The method note on confidence and checks (D-478): what "N of M" counts, what a small sample is,
 * and what the verification removed, with its counts.
 */
function evidenceNote(input: ReportInput): string {
  const n = input.smallSample ?? DEFAULT_SMALL_SAMPLE;
  const parts = [
    `"Mentioned in N of M interviews" counts the distinct interviews in which a topic came up, not how often it was said. A topic that rests on ${n === 1 ? "one interview" : `${n} interviews or fewer`} is marked as a small sample: a lead to check, not a finding.`,
    "Every quote was checked word for word against the interview it comes from; a quote that could not be found there is not shown as a quote.",
    "Counts, shares and hours stated in the written summaries were compared with the computed figures, and a sentence whose figure did not match was removed.",
  ];
  const v = input.verification;
  if (v && (v.quotesDropped > 0 || v.figuresRemoved > 0)) {
    const dropped: string[] = [];
    if (v.quotesDropped > 0)
      dropped.push(
        `${v.quotesDropped} quote${v.quotesDropped === 1 ? "" : "s"} could not be verified and ${v.quotesDropped === 1 ? "was" : "were"} left out`,
      );
    if (v.figuresRemoved > 0)
      dropped.push(
        `${v.figuresRemoved} sentence${v.figuresRemoved === 1 ? "" : "s"} with an unconfirmed figure ${v.figuresRemoved === 1 ? "was" : "were"} removed`,
      );
    parts.push(`In this version, ${dropped.join(", and ")}.`);
  }
  return parts.join(" ");
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
    `Each group below has at least ${k} participants. Shares are of the group's own participants; hours are self-reported, not measured.`,
    "",
    `| Group | Participants | Hours per week | ${COMPARED_CLASSES.map((c) => CLASS_LABEL[c]).join(" | ")} |`,
    `|---|---|---|${COMPARED_CLASSES.map(() => "---").join("|")}|`,
  );
  for (const row of d.departments) {
    const name = row.kind === "other" ? "Other departments" : (row.name ?? "Unspecified");
    out.push(
      `| ${name} | ${row.participants} | ${Math.round(row.minutesPerWeek / 60)} | ${COMPARED_CLASSES.map((c) => pct(row.solutionClassShare[c])).join(" | ")} |`,
    );
  }
  // The opportunities each group described most are sentences, so they are a list under the table:
  // as an eighth column they were a strip one word wide, on the page and in the PDF (D-321).
  out.push("", "Most shared by each group:", "");
  for (const row of d.departments) {
    const name = row.kind === "other" ? "Other departments" : (row.name ?? "Unspecified");
    const top =
      row.topOpportunities.map((t) => `${t.title} (${pct(t.share)})`).join("; ") ||
      "none shared by enough people";
    out.push(`- **${name}:** ${top}`);
  }
  out.push("");
  if (d.belowK > 0)
    out.push(
      `${d.belowK} department${d.belowK === 1 ? "" : "s"} with fewer than ${k} participants ${d.belowK === 1 ? "is" : "are"} not shown by name.`,
      "",
    );
  return out;
}

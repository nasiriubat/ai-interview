import { REPORT_SECTIONS } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { renderReport, type ReportInput } from "../../src/analysis/report.js";

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  campaignName: "Ward",
  generatedAt: new Date("2026-10-14T00:00:00Z"),
  participation: { invited: 8, completed: 6, sessionsAnalyzed: 6, facts: 40, thresholdMet: true },
  opportunities: [],
  narrative: { executiveSummary: "E", nextSteps: ["n"], caveats: "c" },
  sections: [...REPORT_SECTIONS],
  k: 3,
  language: "en",
  ...over,
});

describe("the report cover (positioning 3)", () => {
  it("states the method, what the report does not do and how to reproduce it, before the first section", () => {
    const md = renderReport(
      input({
        provenance: {
          templateKey: "opportunity_discovery",
          templateVersion: 2,
          promptVersions: ["narrative@p1", "clustering@3"],
          weightsPreset: "quick_wins",
        },
      }),
    );
    const cover = md.slice(0, md.indexOf("\n## "));
    expect(cover).toContain("**Method.** 6 of 8 invited people completed a structured interview");
    expect(cover).toContain("**What this report does not do.**");
    expect(cover).toContain("at least 3 participants are behind it");
    expect(cover).toContain(
      "**Reproducibility.** template opportunity_discovery v2; prompts clustering@3, narrative@p1; weights preset quick_wins.",
    );
  });

  it("adds no level-2 heading, so the n-th heading is still the n-th section", () => {
    const md = renderReport(input());
    expect([...md.matchAll(/^## (.+)$/gm)]).toHaveLength(REPORT_SECTIONS.length);
    expect(md.match(/^# /gm)).toHaveLength(1);
  });

  it("does not guess: no provenance, no reproducibility line; an unknown invited count is not printed", () => {
    const md = renderReport(
      input({
        participation: { invited: 0, completed: 1, sessionsAnalyzed: 1, facts: 3, thresholdMet: false },
      }),
    );
    expect(md).not.toContain("Reproducibility");
    expect(md).toContain("1 person completed a structured interview");
    expect(md).toContain("1 interview was analyzed");
  });
});

describe("confidence in the report (D-478)", () => {
  const factors = Object.fromEntries(
    [
      "expected_impact",
      "affected_employees",
      "frequency",
      "implementation_complexity",
      "data_availability",
      "risk",
      "ai_suitability",
    ].map((k) => [k, { score: 4, rationale: "r" }]),
  ) as ReportInput["opportunities"][number]["factors"];
  const opp = (title: string, sessions: number) => ({
    clusterKey: title,
    title,
    summary: "S.",
    solutionClass: "automation" as const,
    rankScore: 70,
    factors,
    stats: {
      participants: sessions,
      sessions,
      facts: sessions,
      roles: [],
      departments: [],
      tools: [],
      minutesPerWeekTotal: 0,
      quotes: [],
    },
    processes: [],
  });

  it("states what the report is based on, with the interviews begun", () => {
    const md = renderReport(
      input({
        participation: {
          invited: 20,
          completed: 12,
          sessionsAnalyzed: 12,
          facts: 80,
          thresholdMet: true,
          started: 15,
        },
      }),
    );
    expect(md).toContain("**Based on 12 completed interviews (15 started).**");
    expect(md).not.toContain("**Small sample.**");
    expect(md).toContain("**How to read the evidence.**");
  });

  it("says calmly when the campaign is below its threshold", () => {
    const md = renderReport(
      input({
        participation: {
          invited: 20,
          completed: 4,
          sessionsAnalyzed: 4,
          facts: 20,
          thresholdMet: false,
          needed: 10,
        },
      }),
    );
    expect(md).toContain(
      "**Small sample.** The campaign set 10 completed interviews as the point where results are representative, and this report has 4.",
    );
  });

  it("puts 'Mentioned in N of M interviews' on every opportunity, and marks the ones that rest on one or two", () => {
    const md = renderReport(input({ opportunities: [opp("Shared form", 5), opp("Lab call", 1)] }));
    expect(md).toContain("Mentioned in 5 of 6 interviews");
    expect(md).toContain("| 70 | Shared form | 5 of 6 |");
    expect(md).toContain(
      "*Mentioned in 1 of 6 interviews. Small sample: this rests on one interview, so treat it as a lead to check rather than a finding.*",
    );
    expect(md).not.toMatch(/Shared form[^\n]*Small sample/);
  });

  it("sets each quote as a blockquote of its own, so two people's words never run together", () => {
    const o = opp("Shared form", 5);
    const md = renderReport(
      input({ opportunities: [{ ...o, stats: { ...o.stats, quotes: ["first words", "second words"] } }] }),
    );
    expect(md).toContain("> first words\n\n> second words");
  });

  it("states what the checks left out", () => {
    const md = renderReport(
      input({
        verification: {
          quotesChecked: 10,
          quotesVerified: 8,
          quotesDropped: 2,
          figuresChecked: 4,
          figuresRemoved: 1,
        },
      }),
    );
    expect(md).toContain(
      "In this version, 2 quotes could not be verified and were left out, and 1 sentence with an unconfirmed figure was removed.",
    );
  });
});

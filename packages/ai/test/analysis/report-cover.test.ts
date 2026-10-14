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

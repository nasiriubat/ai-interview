import { describe, expect, it } from "vitest";
import { compareDepartments } from "../../src/analysis/departments.js";
import type { AnalysisFact } from "../../src/analysis/pipeline.js";
import { renderReport } from "../../src/analysis/report.js";

let seq = 0;
const people = (department: string, n: number): AnalysisFact[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${department}-${seq++}`,
    sessionId: `${department}-s${i}`,
    participantKey: `${department}-p${i}`,
    department,
    fact: {
      kind: "task" as const,
      name: "x",
      frequency: "weekly" as const,
      minutesPerOccurrence: 60,
      tools: [],
      painScore: 3,
    },
  }));

const render = (departments: ReturnType<typeof compareDepartments>): string =>
  renderReport({
    campaignName: "C",
    generatedAt: new Date("2026-01-01"),
    participation: { invited: 1, completed: 1, sessionsAnalyzed: 1, facts: 1, thresholdMet: true },
    opportunities: [],
    narrative: { executiveSummary: "E", nextSteps: ["n"], caveats: "c" },
    sections: ["participation", "department_comparison", "next_steps"],
    k: 3,
    language: "en",
    departments,
  });

describe("the department section of the report (FR-17)", () => {
  it("is exactly one heading whether or not the comparison is shown, so section numbering holds", () => {
    const hidden = render(compareDepartments({ facts: [], opportunities: [], k: 3, enabled: true }));
    expect(hidden.match(/^## /gm)).toHaveLength(3);
    expect(hidden).toContain("Not shown");
    expect(hidden).toContain("at least 3 participants");

    const facts = [...people("Ward", 3), ...people("Pharmacy", 3), ...people("Lab", 1)];
    const shown = render(compareDepartments({ facts, opportunities: [], k: 3, enabled: true }));
    expect(shown.match(/^## /gm)).toHaveLength(3);
    expect(shown).toContain("| Ward | 3 |");
    expect(shown).not.toContain("Lab");
    expect(shown).toContain("1 department with fewer than 3 participants is not shown by name.");
  });

  it("says the comparison is switched off when the setting is off", () => {
    const off = render(
      compareDepartments({ facts: people("Ward", 5), opportunities: [], k: 3, enabled: false }),
    );
    expect(off).toContain("turned off");
  });
});

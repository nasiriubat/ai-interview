import { describe, expect, it } from "vitest";
import {
  checkKAnonymity,
  checkSpec,
  leakedNames,
  reportSectionsPresent,
  SPEC_SECTION_KEYS,
  type OpportunityView,
  type SpecDocumentView,
} from "../src/checks.js";

const opp = (over: Partial<OpportunityView>): OpportunityView => ({
  id: "o1",
  clusterKey: "double_entry",
  title: "Double entry",
  summary: "s",
  solutionClass: "automation",
  rankScore: 70,
  status: "new",
  stats: { participants: 2, facts: 3, roles: [], departments: [], quotes: [] },
  evidence: [],
  dataNeeded: [],
  risks: [],
  ...over,
});

describe("checkKAnonymity", () => {
  const quote = "We type the same observations into the record again after the round ends";
  const quotes = new Map([["f1", quote]]);

  it("passes a small cluster that exposes nothing", () => {
    expect(checkKAnonymity([opp({})], 3, quotes, "# Report")).toEqual([]);
  });
  it("flags quotes, breakdowns and verbatim evidence below k", () => {
    const bad = opp({
      stats: { participants: 2, facts: 3, roles: ["Nurse"], departments: [], quotes: ["x"] },
      evidence: [{ factId: "f1", snippet: `"${quote}."`, anonymized: true }],
    });
    const problems = checkKAnonymity([bad], 3, quotes, `...${quote}...`).map((f) => f.problem);
    expect(problems).toHaveLength(4);
  });
  it("ignores clusters at or above k", () => {
    const ok = opp({
      stats: { participants: 3, facts: 3, roles: ["Nurse"], departments: [], quotes: ["q"] },
    });
    expect(checkKAnonymity([ok], 3, quotes, "")).toEqual([]);
  });
});

describe("leakedNames", () => {
  it("matches whole words only", () => {
    expect(leakedNames("Maija said hello. Pekkala is not Pekka.", ["Maija", "Pekka", "Olli"])).toEqual([
      "Maija",
      "Pekka",
    ]);
    expect(leakedNames("Pekkala", ["Pekka"])).toEqual([]);
  });
});

describe("reportSectionsPresent", () => {
  it("detects headings", () => {
    const md = "## Executive summary\n\n## Work map\n\n## Recommended next steps";
    const r = reportSectionsPresent(md);
    expect(r.executive_summary).toBe(true);
    expect(r.work_map).toBe(true);
    expect(r.not_ai).toBe(false);
  });
});

describe("checkSpec", () => {
  const doc = (over: Partial<SpecDocumentView>): SpecDocumentView => ({
    title: "T",
    sections: SPEC_SECTION_KEYS.map((key) => ({
      key,
      title: key,
      markdown: "x".repeat(120),
      source: "generated",
    })),
    requirements: [
      { id: "FR-1", title: "a", scope: "mvp", acceptance: ["given when then"] },
      { id: "FR-2", title: "b", scope: "mvp", acceptance: [] },
    ],
    phases: [{ key: "p1", name: "P1", tasks: [{ title: "t", acceptance: [] }], acceptance: ["a"] }],
    openQuestions: [],
    diagrams: [{ key: "d", title: "d", type: "context", mermaid: "graph TD; A-->B" }],
    ...over,
  });

  it("reports a complete document", () => {
    const c = checkSpec(doc({}), ["Implements FR-1 and FR-2"]);
    expect(c.sectionsMissing).toEqual([]);
    expect(c.requirementIdsShortSequential).toBe(true);
    expect(c.requirementsWithoutAcceptance).toEqual(["FR-2"]);
    expect(c.phaseTasksWithoutAcceptance).toBe(1);
    expect(c.unknownIdsInTasks).toEqual([]);
  });
  it("flags slug ids, duplicates, fallback sections and unknown ids in tasks", () => {
    const d = doc({
      sections: [{ key: "overview", title: "o", markdown: "short", source: "fallback" }],
      requirements: [
        { id: "FR-campaigns", title: "a", scope: "mvp", acceptance: ["x"] },
        { id: "FR-campaigns", title: "b", scope: "mvp", acceptance: ["x"] },
      ],
    });
    const c = checkSpec(d, ["see FR-9"]);
    expect(c.requirementIdsShortSequential).toBe(false);
    expect(c.requirementIdsDuplicated).toEqual(["FR-campaigns"]);
    expect(c.sectionsFallback).toEqual(["overview"]);
    expect(c.sectionsEmpty).toEqual(["overview"]);
    expect(c.sectionsMissing).toHaveLength(SPEC_SECTION_KEYS.length - 1);
    expect(c.unknownIdsInTasks).toEqual(["FR-9"]);
  });
});

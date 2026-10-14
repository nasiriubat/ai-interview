import type { Fact } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { GoldFact, GoldRequirement } from "./fixture.js";
import {
  contractTally,
  coverageProgression,
  factRecall,
  frIdIntegrity,
  gate,
  issueDetection,
  requirementCapture,
  specCompleteness,
} from "./metrics.js";

const gold = (
  id: string,
  terms: string[],
  scope: "mvp" | "future" = "mvp",
  finalScope?: "mvp" | "future",
): GoldRequirement => ({
  id,
  title: id,
  terms,
  scope,
  acceptance: [],
  introducedAtTurn: 1,
  ...(finalScope ? { finalScope } : {}),
});

describe("coverageProgression", () => {
  it("passes a rising curve that meets its milestones", () => {
    const r = coverageProgression([0, 1, 1, 2, 3], [{ afterTurn: 4, covered: 2 }]);
    expect(r).toMatchObject({ pass: true, mismatches: [] });
  });
  it("fails a curve that falls or misses a milestone", () => {
    const r = coverageProgression([0, 2, 1], [{ afterTurn: 3, covered: 3 }]);
    expect(r.pass).toBe(false);
    expect(r.mismatches).toEqual(["coverage fell at turn 3", "after turn 3: 1 covered, expected 3"]);
  });
  it("holds the last value for a milestone past the end of a short interview", () => {
    expect(coverageProgression([0, 3], [{ afterTurn: 30, covered: 3 }]).pass).toBe(true);
  });
});

describe("requirementCapture", () => {
  const recorded = [
    { path: "FR-1", title: "Enter a note once", scope: "mvp" as const },
    { path: "FR-2", title: "Export to Excel", scope: "mvp" as const },
  ];
  it("counts gold requirements found by their terms and names the missed ones", () => {
    const r = requirementCapture(
      [gold("A", ["note", "once"]), gold("B", ["excel"]), gold("C", ["offline"])],
      recorded,
      [],
    );
    expect(r).toMatchObject({ gold: 3, captured: 2, missed: ["C"], rate: 0.667 });
  });
  it("reports a captured requirement whose final scope is wrong", () => {
    const r = requirementCapture([gold("B", ["excel"], "mvp", "future")], recorded, []);
    expect(r.scopeWrong).toEqual(["B"]);
  });
  it("counts a rule that carries a requirement's terms as filed in the wrong section", () => {
    const r = requirementCapture([gold("B", ["excel", "export"])], [], ['"The system must export to Excel"']);
    expect(r.misfiled).toBe(1);
    expect(r.rate).toBe(0);
  });
  it("is 1 for a fixture with no gold requirements", () => {
    expect(requirementCapture([], recorded, []).rate).toBe(1);
  });
});

describe("frIdIntegrity", () => {
  it("accepts FR-1..FR-n in order", () => {
    expect(frIdIntegrity(["FR-1", "FR-2", "FR-3"])).toEqual({ ok: true, violations: [] });
  });
  it("names descriptive ids, duplicates and gaps", () => {
    const r = frIdIntegrity(["FR-1", "FR-export", "FR-1", "FR-5"]);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      "FR-export: not an FR id",
      "FR-export: expected FR-2",
      "FR-1: duplicate",
      "FR-1: expected FR-3",
      "FR-5: expected FR-4",
    ]);
  });
});

describe("specCompleteness", () => {
  const base = {
    filledSections: ["overview", "users"],
    requiredSections: ["overview", "users", "functional"],
    minRequirements: 2,
  };
  it("scores a complete specification 1", () => {
    const r = specCompleteness({
      ...base,
      requirements: [
        { acceptance: ["a"], scope: "mvp" },
        { acceptance: ["b"], scope: "future" },
      ],
    });
    expect(r).toMatchObject({ score: 1, failed: [] });
  });
  it("lists what is missing", () => {
    const r = specCompleteness({
      ...base,
      filledSections: ["overview"],
      requirements: [{ acceptance: [], scope: "mvp" }],
    });
    expect(r.failed).toEqual(["section:users", "requirements>=2", "acceptance"]);
    expect(r.score).toBe(0.5);
  });
});

describe("factRecall", () => {
  const fact = (name: string): Fact => ({
    kind: "task",
    name,
    frequency: "daily",
    minutesPerOccurrence: 10,
    tools: [],
    painScore: 3,
  });
  const g = (id: string, terms: string[], must = true): GoldFact => ({
    id,
    kind: "task",
    terms,
    introducedAtTurn: 1,
    mustSurviveSummary: must,
    fact: fact(id),
  });
  it("recalls from structured facts, the summary or the window", () => {
    const r = factRecall([g("a", ["charting"]), g("b", ["lab"]), g("c", ["bed"])], {
      facts: [fact("Charting twice")],
      summary: "- I phone the lab",
      window: "nothing relevant",
    });
    expect(r).toMatchObject({ gold: 3, recalled: 2, missed: ["c"] });
  });
  it("ignores facts not marked to survive", () => {
    const r = factRecall([g("a", ["zzz"], false)], { facts: [], summary: "", window: "" });
    expect(r).toMatchObject({ gold: 0, rate: 1 });
  });
});

describe("issueDetection", () => {
  it("computes precision and recall by type and section", () => {
    const r = issueDetection(
      [
        { type: "contradiction", section: "functional" },
        { type: "ambiguity", section: "nfr" },
      ],
      [
        { type: "contradiction", section: "Functional Requirements" },
        { type: "missing_decision", section: "security" },
      ],
    );
    expect(r).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
  });
  it("matches each gold finding once", () => {
    const r = issueDetection(
      [
        { type: "ambiguity", section: "nfr" },
        { type: "ambiguity", section: "nfr" },
      ],
      [{ type: "ambiguity", section: "nfr" }],
    );
    expect(r).toMatchObject({ tp: 1, fp: 1, fn: 0 });
  });
});

describe("contractTally and gate", () => {
  it("rates marker misses and failures over turns", () => {
    const t = contractTally([
      { markerMissed: false, outcome: "clean", repairCalls: 0 },
      { markerMissed: true, outcome: "repaired", repairCalls: 1 },
      { markerMissed: true, outcome: "failed", repairCalls: 1 },
      { markerMissed: false, outcome: "clean", repairCalls: 0 },
    ]);
    expect(t).toMatchObject({ turns: 4, markerMissRate: 0.5, failureRate: 0.25, repairCalls: 2 });
  });
  it("fails exact metrics on any change and ratio metrics beyond the tolerance, and only in the bad direction", () => {
    const rules = { ended: "equal", capture: "min", failures: "max" } as const;
    expect(
      gate({ ended: true, capture: 0.9, failures: 0 }, { ended: true, capture: 0.9, failures: 0 }, rules),
    ).toEqual([]);
    expect(
      gate({ ended: false, capture: 0.9, failures: 0 }, { ended: true, capture: 0.9, failures: 0 }, rules),
    ).toEqual(["ended: false (baseline true)"]);
    expect(
      gate({ ended: true, capture: 0.8, failures: 0.1 }, { ended: true, capture: 0.9, failures: 0 }, rules),
    ).toEqual(["capture: fell from 0.9 to 0.8", "failures: rose from 0 to 0.1"]);
    // Getting better is not a failure.
    expect(
      gate({ ended: true, capture: 1, failures: 0 }, { ended: true, capture: 0.9, failures: 0.05 }, rules),
    ).toEqual([]);
    // Within tolerance is not a failure either.
    expect(
      gate({ ended: true, capture: 0.89, failures: 0 }, { ended: true, capture: 0.9, failures: 0 }, rules),
    ).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  agreement,
  applyClusters,
  goldRecall,
  pool,
  redundantCopies,
  scoreSpec,
  verifyVerdicts,
  type ManualLabel,
  type RawVerdict,
  type RequirementUnderJudgement,
  type Verdict,
} from "./spec-quality.js";

const req = (id: string, title = id): RequirementUnderJudgement => ({
  id,
  title,
  scope: "mvp",
  acceptance: ["a"],
});

const said = ["I want to type the note once, and it must reach the patient system and the spreadsheet."];

const verdict = (id: string, over: Partial<Verdict> = {}): Verdict => ({
  id,
  grounded: "yes",
  groundedVerified: true,
  quote: "x",
  granularity: "ok",
  kind: "capability",
  testable: "yes",
  scope: "correct",
  duplicateOf: null,
  adjustments: [],
  ...over,
});

describe("verifying what the judge says (D-245)", () => {
  it("accepts a grounded yes only with a quote the participant said", () => {
    const raw: RawVerdict[] = [
      { id: "FR-1", grounded: "yes", quote: "I want to type the note once" },
      { id: "FR-2", grounded: "yes", quote: "the nurse shall sign every page in ink" },
      { id: "FR-3", grounded: "yes" },
    ];
    const out = verifyVerdicts([req("FR-1"), req("FR-2"), req("FR-3")], raw, said);
    expect(out.map((v) => [v.grounded, v.groundedVerified])).toEqual([
      ["yes", true],
      ["partial", false],
      ["partial", false],
    ]);
    expect(out[1]?.adjustments[0]).toMatch(/not in the participant's words/);
  });

  it("reads a missing verdict as the harshest one, so silence never improves a score", () => {
    const [v] = verifyVerdicts([req("FR-9")], [], said);
    expect(v).toMatchObject({ grounded: "no", testable: "no", scope: "unclear", duplicateOf: null });
    expect(v?.adjustments).toContain("judge returned no verdict");
  });

  it("drops a duplicate-of that names itself or a requirement that is not listed", () => {
    const out = verifyVerdicts(
      [req("FR-1"), req("FR-2"), req("FR-3")],
      [
        { id: "FR-2", duplicateOf: "FR-1" },
        { id: "FR-3", duplicateOf: "FR-3" },
        { id: "FR-1", duplicateOf: "FR-77" },
      ],
      said,
    );
    expect(out.map((v) => v.duplicateOf)).toEqual([null, "FR-1", null]);
  });
});

describe("scoring a specification", () => {
  it("counts a duplicate pair once, as the later copy, even when the judge flags both ways", () => {
    const vs = [
      verdict("FR-1", { duplicateOf: "FR-2" }),
      verdict("FR-2", { duplicateOf: "FR-1" }),
      verdict("FR-3"),
      verdict("FR-4"),
    ];
    expect([...redundantCopies(vs)]).toEqual(["FR-2"]);
    expect(scoreSpec(vs).duplicateRate).toBe(0.25);
  });

  it("computes the rates from the verdicts", () => {
    const vs = [
      verdict("FR-1"),
      verdict("FR-2", { grounded: "partial", groundedVerified: false, testable: "partly" }),
      verdict("FR-3", { granularity: "too_fine", kind: "detail", scope: "wrong" }),
      verdict("FR-4", { kind: "decision", scope: "unclear" }),
    ];
    expect(scoreSpec(vs, { unconfirmedIds: ["FR-2"] })).toEqual({
      count: 4,
      groundedRate: 0.75,
      duplicateRate: 0,
      overGranularRate: 0.25,
      nonRequirementRate: 0.25,
      testableRate: 0.75,
      scopeAccuracy: 0.75,
      flaggedUnconfirmed: 1,
    });
  });

  it("counts a scope tag the transcript is silent about as standing, and handles an empty specification", () => {
    expect(scoreSpec([verdict("FR-1", { scope: "unclear" })]).scopeAccuracy).toBe(1);
    expect(scoreSpec([verdict("FR-1", { scope: "wrong" })]).scopeAccuracy).toBe(0);
    expect(scoreSpec([]).groundedRate).toBe(0);
  });

  it("pools several specifications without letting ids collide across them", () => {
    const a = [verdict("FR-1"), verdict("FR-2", { duplicateOf: "FR-1" })];
    const b = [verdict("FR-1"), verdict("FR-2", { duplicateOf: "FR-1" }), verdict("FR-3"), verdict("FR-4")];
    const p = pool([{ verdicts: a }, { verdicts: b }]);
    expect(p.count).toBe(6);
    expect(p.duplicateRate).toBe(0.333);
  });
});

describe("agreement with manual labels", () => {
  const manual = (id: string, over: Partial<ManualLabel> = {}): ManualLabel => ({
    spec: "s",
    id,
    grounded: "yes",
    granularity: "ok",
    kind: "capability",
    testable: "yes",
    scope: "correct",
    duplicateOf: null,
    ...over,
  });

  it("reports raw agreement and kappa per dimension, and who said what on a disagreement", () => {
    const pairs = [
      { judge: verdict("a"), manual: manual("a") },
      { judge: verdict("b", { duplicateOf: "a" }), manual: manual("b", { duplicateOf: "a" }) },
      { judge: verdict("c", { duplicateOf: "a" }), manual: manual("c") },
      { judge: verdict("d"), manual: manual("d", { duplicateOf: "a" }) },
    ];
    const dup = agreement(pairs, ["duplicate"])[0];
    expect(dup).toMatchObject({ n: 4, agree: 2, agreement: 0.5, judgeOnly: 1, manualOnly: 1 });
    expect(dup?.kappa).toBe(0);
  });

  it("compares scope only as contradicted or not, and gives no kappa for one class", () => {
    const pairs = [
      { judge: verdict("a"), manual: manual("a") },
      { judge: verdict("b", { scope: "unclear" }), manual: manual("b") },
      { judge: verdict("c"), manual: manual("c", { scope: "unclear" }) },
    ];
    const scope = agreement(pairs, ["scope"])[0];
    expect(scope).toMatchObject({ n: 3, agree: 3, agreement: 1 });
    expect(scope?.kappa).toBeNull();
    const wrong = agreement([{ judge: verdict("a", { scope: "wrong" }), manual: manual("a") }], ["scope"])[0];
    expect(wrong).toMatchObject({ agree: 0, judgeOnly: 1 });
  });

  it("groups a clustered list so the later members repeat the earliest", () => {
    const vs = ["FR-1", "FR-2", "FR-3", "FR-4", "FR-5"].map((id) => verdict(id));
    const out = applyClusters(vs, [["FR-4", "FR-2", "FR-9"], ["FR-3"], ["FR-2", "FR-5"]]);
    expect(out.map((v) => v.duplicateOf)).toEqual([null, null, null, "FR-2", "FR-2"]);
    expect(scoreSpec(out).duplicateRate).toBe(0.4);
  });
});

describe("recall against a gold list", () => {
  it("covers a capability when every word of one alternative appears in a requirement", () => {
    const gold = [
      { key: "once", description: "type once", anyOf: [["once"], ["single", "entry"]] },
      { key: "sync", description: "reach the spreadsheet", anyOf: [["spreadsheet"]] },
    ];
    const r = goldRecall(gold, [
      { id: "FR-1", title: "Nurse enters a note once", scope: "mvp", acceptance: [] },
      { id: "FR-2", title: "Export the list", scope: "mvp", acceptance: ["CSV opens in Excel"] },
    ]);
    expect(r).toEqual({ covered: ["once"], missing: ["sync"], recall: 0.5 });
  });
});

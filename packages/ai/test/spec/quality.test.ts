import type { Fact } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import {
  classifyRequirement,
  contentTokens,
  curateRequirements,
  findDuplicatePairs,
  groupPairs,
  isUiDetail,
  mergeGroup,
  requirementSimilarity,
  type ReqView,
} from "../../src/spec/quality.js";

const req = (id: string, title: string, extra: Partial<ReqView> = {}): ReqView => ({
  id,
  title,
  scope: "mvp",
  acceptance: [],
  ...extra,
});

const fact = (id: string, title: string, extra: object = {}): Fact => ({
  kind: "spec_field",
  section: "functional",
  path: id,
  value: { title, scope: "mvp", acceptance: [], ...extra },
  source: "user",
});

describe("similarity of requirement titles", () => {
  it("reads tokens as stems without filler", () => {
    expect(contentTokens("The nurse can confirm the notes")).toEqual(["nurs", "confirm", "not"]);
  });

  it("counts a digit as a word so numbered titles are not the same", () => {
    expect(requirementSimilarity(req("FR-1", "Capability 1"), req("FR-2", "Capability 2"))).toBeLessThan(0.4);
  });

  it("scores the rewordings seen in the 2026-10 measurement as duplicates", () => {
    const a = req("FR-3", "Confirm note saved in Epic");
    const b = req("FR-26", "Confirm help request was received");
    const c = req("FR-17", "Navigate to next patient after confirmation");
    const d = req("FR-18", "Navigate to next patient's note after confirmation");
    expect(requirementSimilarity(c, d)).toBeGreaterThanOrEqual(0.8);
    expect(requirementSimilarity(a, b)).toBeLessThan(0.4);
  });

  it("does not merge two requirements that differ by the one verb that matters", () => {
    const pairs = findDuplicatePairs([
      req("FR-1", "Nurse edits a note"),
      req("FR-2", "Nurse deletes a note"),
    ]);
    expect(pairs.every((p) => p.kind === "candidate")).toBe(true);
  });

  it("sends a contained title to the model instead of merging it", () => {
    const pairs = findDuplicatePairs([
      req("FR-1", "Edit note"),
      req("FR-2", "Edit note history for auditors"),
    ]);
    expect(pairs.some((p) => p.kind === "exact")).toBe(false);
  });
});

describe("classification of a requirement that is not a capability", () => {
  it.each([
    ["Should notes be kept for ten years?", "question"],
    ["Decision: use Azure AD single sign-on", "decision"],
    ["Hosting on the hospital's own servers", "decision"],
    ["Retention of notes for ten years", "constraint"],
    ["GDPR compliance for patient data", "constraint"],
    ["Nurse enters a ward note once", "capability"],
    ["Use barcode scanning to identify the patient", "capability"],
  ] as const)("%s is %s", (title, klass) => {
    expect(classifyRequirement({ title })).toBe(klass);
  });

  it("recognizes a widget of a screen, but not a capability that names one", () => {
    expect(isUiDetail("Save button colour is green")).toBe(true);
    expect(isUiDetail("Export the list to CSV from the toolbar button")).toBe(false);
    expect(isUiDetail("Nurse enters a ward note")).toBe(false);
  });
});

describe("merging a group of duplicates", () => {
  it("keeps the strongest acceptance and records where the rest went", () => {
    const merged = mergeGroup([
      req("FR-4", "Show success message", { acceptance: ["Message appears"] }),
      req("FR-9", "Show success confirmation", {
        acceptance: ["Message appears", "Shows patient name and time"],
      }),
      req("FR-12", "Success message details", { acceptance: ["Includes record number"] }),
    ]);
    expect(merged.id).toBe("FR-9");
    expect(merged.acceptance).toEqual([
      "Message appears",
      "Shows patient name and time",
      "Includes record number",
    ]);
    expect(merged.mergedFrom).toEqual(["FR-4", "FR-12"]);
  });

  it("lets the owner's recorded decision decide scope, and otherwise prefers mvp", () => {
    expect(
      mergeGroup([
        req("FR-1", "x", { scope: "mvp" }),
        req("FR-2", "x", { scope: "future", reason: "owner said later" }),
      ]).scope,
    ).toBe("future");
    expect(
      mergeGroup([req("FR-1", "x", { scope: "future" }), req("FR-2", "x", { scope: "mvp" })]).scope,
    ).toBe("mvp");
  });

  it("clears needsConfirmation when any copy has the owner's words", () => {
    const merged = mergeGroup([
      req("FR-1", "x", { needsConfirmation: true }),
      req("FR-2", "x", { evidence: "we need x" }),
    ]);
    expect(merged.evidence).toBe("we need x");
    expect(merged.needsConfirmation).toBeUndefined();
  });

  it("groups pairs transitively in id order", () => {
    expect(
      groupPairs(
        ["FR-1", "FR-2", "FR-3", "FR-4"],
        [
          { a: "FR-1", b: "FR-3" },
          { a: "FR-3", b: "FR-4" },
        ],
      ),
    ).toEqual([["FR-1", "FR-3", "FR-4"]]);
  });
});

describe("curating the requirements of a session", () => {
  const facts: Fact[] = [
    fact("FR-1", "Nurse reviews note before sending to Epic", { acceptance: ["Review screen appears"] }),
    fact("FR-2", "Nurse reviews note before sending to Epic", { acceptance: ["Edit is possible"] }),
    fact("FR-3", "Navigate to next patient after confirmation"),
    fact("FR-4", "Navigate to next patient's note after confirmation"),
    fact("FR-5", "Should notes be kept for ten years?"),
    fact("FR-6", "Retry failed Epic save", { acceptance: ["Retry is offered after a failure"] }),
    { kind: "spec_field", section: "rules", path: "limit", value: "200 words", source: "user" },
  ];

  it("merges exact duplicates, reroutes the question, and leaves the other sections alone", () => {
    const { facts: out, report } = curateRequirements({ facts });
    const functional = out.filter((f) => f.kind === "spec_field" && f.section === "functional");
    expect(functional.map((f) => (f.kind === "spec_field" ? f.path : ""))).toEqual(["FR-1", "FR-3", "FR-6"]);
    expect(report.merged.map((m) => `${m.into}<-${m.from.join(",")}`)).toEqual(["FR-1<-FR-2", "FR-3<-FR-4"]);
    expect(report.rerouted).toEqual([{ id: "FR-5", as: "question", section: "open_questions" }]);
    expect(out.some((f) => f.kind === "spec_field" && f.section === "open_questions")).toBe(true);
    expect(out.some((f) => f.kind === "spec_field" && f.section === "rules" && f.path === "limit")).toBe(
      true,
    );
    const first = out.find((f) => f.kind === "spec_field" && f.path === "FR-1");
    expect(first?.kind === "spec_field" && (first.value as { acceptance: string[] }).acceptance).toEqual([
      "Review screen appears",
      "Edit is possible",
    ]);
  });

  it("returns pairs it could not settle, and does not offer them again once a model said they differ", () => {
    const set: Fact[] = [
      fact("FR-1", "Retry failed Epic save"),
      fact("FR-2", "Retry failed Epic save after a timeout or an error message"),
    ];
    const first = curateRequirements({ facts: set });
    expect(first.report.candidates).toHaveLength(1);
    expect(first.facts).toHaveLength(2);
    const second = curateRequirements({ facts: set }, { modelDistinct: [{ a: "FR-1", b: "FR-2" }] });
    expect(second.report.candidates).toHaveLength(0);
    const merged = curateRequirements({ facts: set }, { modelDuplicates: [{ a: "FR-1", b: "FR-2" }] });
    expect(merged.report.merged).toEqual([{ into: "FR-1", from: ["FR-2"], via: "model" }]);
  });

  it("folds a screen detail into the capability it belongs to as an acceptance criterion", () => {
    const set: Fact[] = [
      fact("FR-1", "Nurse reviews note before sending to Epic", { acceptance: ["Review screen appears"] }),
      fact("FR-2", "Review note screen has a green Send button", { acceptance: ["Button reads Send"] }),
    ];
    const { facts: out, report } = curateRequirements({ facts: set });
    expect(report.folded).toEqual([{ id: "FR-2", into: "FR-1" }]);
    expect(out).toHaveLength(1);
  });

  it("never renumbers a survivor", () => {
    const { facts: out } = curateRequirements({
      facts: [
        fact("FR-1", "Export notes to CSV"),
        fact("FR-2", "Export the notes to a CSV"),
        fact("FR-3", "Search notes"),
      ],
    });
    expect(out.map((f) => (f.kind === "spec_field" ? f.path : ""))).toEqual(["FR-1", "FR-3"]);
  });
});

import type { Fact } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import {
  checkSpecFacts,
  looksLikeRequirement,
  nextRequirementNumber,
  salvageRejected,
} from "../../src/spec/delta-validation.js";

const spec = (section: string, path: string, value: unknown): Fact => ({
  kind: "spec_field",
  section,
  path,
  value,
  source: "user",
});
const req = (title: string, extra: object = {}) => ({ title, scope: "mvp", acceptance: ["works"], ...extra });
const none = { facts: [] as Fact[] };
const pathsOf = (facts: Fact[], section = "functional"): string[] =>
  facts.flatMap((f) => (f.kind === "spec_field" && f.section === section ? [f.path] : []));

describe("checkSpecFacts (D-190)", () => {
  it("passes facts through untouched for a template that produces no specification", () => {
    const f = spec("rules", "x", "y");
    const r = checkSpecFacts([f], none, { producesSpec: false });
    expect(r.facts).toEqual([f]);
    expect(r.repaired).toEqual([]);
  });

  it("canonicalizes section names", () => {
    const r = checkSpecFacts([spec("Business Rules", "limit", "max 5")], none);
    expect(pathsOf(r.facts, "rules")).toEqual(["limit"]);
    expect(r.repaired[0]?.kind).toBe("section_normalized");
  });

  it("moves a requirement filed under rules to functional with the next id", () => {
    const state = { facts: [spec("functional", "FR-1", req("One"))] };
    const r = checkSpecFacts([spec("rules", "export-rule", req("Export to Excel"))], state);
    expect(pathsOf(r.facts)).toEqual(["FR-2"]);
    expect(r.repaired.map((x) => x.kind)).toContain("moved_to_functional");
    expect(r.rejected).toEqual([]);
  });

  it("assigns sequential unique ids in capture order, whatever paths the model chose", () => {
    const r = checkSpecFacts(
      [
        spec("functional", "FR-export", req("Export")),
        spec("functional", "functional-1", req("Search")),
        spec("functional", "FR-9", req("Share")),
        spec("functional", "FR-9", req("Share, again")),
      ],
      none,
    );
    expect(pathsOf(r.facts)).toEqual(["FR-1", "FR-2", "FR-3"]);
    expect(new Set(pathsOf(r.facts)).size).toBe(3);
    // The same id twice in one delta is one requirement: the later wording wins.
    expect(r.facts.find((f) => f.kind === "spec_field" && f.path === "FR-3")).toMatchObject({
      value: { title: "Share, again" },
    });
  });

  it("re-records an existing id in place and reuses the id of an identical title", () => {
    const state = {
      facts: [spec("functional", "FR-1", req("One")), spec("functional", "FR-2", req("Export to Excel"))],
    };
    const r = checkSpecFacts(
      [
        spec("functional", "FR-1", req("One", { scope: "future" })),
        spec("functional", "excel", req("export to excel")),
      ],
      state,
    );
    expect(pathsOf(r.facts)).toEqual(["FR-1", "FR-2"]);
    expect(r.repaired.map((x) => x.kind)).toContain("deduplicated");
  });

  it("normalizes the value: plain text becomes a requirement, scope defaults to mvp, acceptance is a list", () => {
    const r = checkSpecFacts(
      [
        spec("functional", "FR-1", "Nurses can chart once"),
        spec("functional", "FR-2", { name: "Export", acceptance: "a file downloads", future: true }),
      ],
      none,
    );
    const [a, b] = r.facts.flatMap((f) => (f.kind === "spec_field" ? [f.value] : []));
    expect(a).toEqual({ title: "Nurses can chart once", scope: "mvp", acceptance: [] });
    expect(b).toMatchObject({ title: "Export", scope: "future", acceptance: ["a file downloads"] });
  });

  it("keeps a plain note in the functional section as a note, not a requirement", () => {
    const r = checkSpecFacts([spec("acceptance", "summary", "Covered in the next round")], none);
    expect(r.facts).toEqual([spec("functional", "summary", "Covered in the next round")]);
    expect(r.rejected).toEqual([]);
  });

  it("puts acceptance criteria written as their own field onto the requirement", () => {
    const state = { facts: [spec("functional", "FR-1", req("One", { acceptance: ["a"] }))] };
    const r = checkSpecFacts(
      [spec("acceptance", "FR-1.acceptance", ["b", "A"]), spec("functional", "FR-2", req("Two"))],
      state,
    );
    expect(pathsOf(r.facts)).toEqual(["FR-1", "FR-2"]);
    expect(r.facts[0]).toMatchObject({ value: { title: "One", acceptance: ["a", "b"] } });
  });

  it("rejects a requirement without any title and an unknown section that is not a requirement", () => {
    const r = checkSpecFacts(
      [spec("functional", "FR-1", { scope: "mvp" }), spec("vibes", "mood", "good")],
      none,
    );
    expect(r.rejected.map((x) => x.reason).sort()).toEqual(["bad_requirement", "unknown_section"]);
    expect(r.facts).toEqual([]);
    expect(salvageRejected(r.heldBack)).toHaveLength(2);
    expect(salvageRejected(r.heldBack)[1]).toMatchObject({
      section: "open_questions",
      path: "vibes.mood",
    });
  });

  it("flags a pile of rules with no requirement anywhere (the 2026-10-14 signature)", () => {
    const rules = Array.from({ length: 6 }, (_, i) => spec("rules", `r${i}`, `Nurses can do ${i}`));
    const r = checkSpecFacts(rules, none);
    expect(r.rejected.map((x) => x.reason)).toContain("rules_without_requirements");
    // ...but not when a requirement exists.
    const ok = checkSpecFacts(rules, { facts: [spec("functional", "FR-1", req("One"))] });
    expect(ok.rejected).toEqual([]);
  });

  it("knows what looks like a requirement", () => {
    expect(looksLikeRequirement("FR-3", "x")).toBe(true);
    expect(looksLikeRequirement("limit", { title: "t", scope: "mvp" })).toBe(true);
    expect(looksLikeRequirement("limit", "max 5 per day")).toBe(false);
    expect(nextRequirementNumber({ facts: [spec("functional", "FR-4", req("x"))] })).toBe(5);
  });
});

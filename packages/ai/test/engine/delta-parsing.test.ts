import { describe, expect, it } from "vitest";
import { parseStateDelta, stripNulls, TurnParser } from "../../src/engine/turn-parser.js";
import { turn } from "./helpers.js";

describe("parseStateDelta (live models send nulls and stray values)", () => {
  it("treats null as absent for optional fields instead of discarding the delta", () => {
    const { delta, dropped } = parseStateDelta({
      coverage: { role: { status: "partial", known: "nurse", missing: null } },
      contextAnswers: { hosting: "azure" },
      profile: { role: "nurse", seniority: null },
      flagForAdmin: null,
      newThreads: null,
    });
    expect(dropped).toEqual([]);
    expect(delta.contextAnswers).toEqual({ hosting: "azure" });
    expect(delta.coverage.role).toEqual({ status: "partial", known: "nurse" });
    expect(delta.profile).toMatchObject({ role: "nurse" });
    expect(delta.profile.seniority).toBeUndefined();
    expect(delta.flagForAdmin).toBeUndefined();
  });

  it("drops invalid facts one by one and keeps a spec_field with an unknown source as user", () => {
    const { delta, dropped } = parseStateDelta({
      facts: [
        { kind: "spec_field", section: "overview", path: "idea", value: "x", source: "prompt" },
        { kind: "task", name: "broken" },
        { kind: "pain_point", description: "slow", severity: 4 },
      ],
      decisions: [{ key: "hosting", question: "Where?", choice: "azure", source: "user" }],
    });
    expect(dropped).toEqual(["facts[1]"]);
    expect(delta.facts).toHaveLength(2);
    expect(delta.facts[0]).toMatchObject({ kind: "spec_field", source: "user" });
    expect(delta.decisions).toHaveLength(1);
  });

  it("removes only the top-level fields that fail and keeps the rest", () => {
    const { delta, dropped } = parseStateDelta({
      contextAnswers: { hosting: "azure" },
      decisions: [{ key: "k", question: "q", choice: "c", source: "made_up" }],
      profile: { technicalSignals: "many" },
    });
    expect(dropped.sort()).toEqual(["decisions", "profile"]);
    expect(delta.contextAnswers).toEqual({ hosting: "azure" });
  });

  it("falls back to an empty delta for garbage", () => {
    expect(parseStateDelta("nope").delta.contextAnswers).toEqual({});
    expect(parseStateDelta(undefined).dropped).toEqual([]);
    expect(stripNulls({ a: null, b: [null, 1], c: { d: null, e: "x" } })).toEqual({ b: [1], c: { e: "x" } });
  });

  it("the turn parser keeps metadata whose stateDelta has nulls", () => {
    const p = new TurnParser();
    p.push(
      turn("Where is it hosted?", {
        areaKey: "context",
        widget: null,
        voiceShortForm: null,
        stateDelta: { contextAnswers: { hosting: "azure" }, flagForAdmin: null },
      }),
    );
    const r = p.finish();
    expect(r.error).toBeUndefined();
    expect(r.meta.areaKey).toBe("context");
    expect(parseStateDelta(r.meta.stateDelta).delta.contextAnswers).toEqual({ hosting: "azure" });
  });
});

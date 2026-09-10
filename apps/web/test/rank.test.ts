import { FACTOR_KEYS, rankScore, WEIGHT_PRESETS, type Factors } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import {
  draftFromOverride,
  EMPTY_DRAFT,
  overrideReducer,
  toOverridePayload,
  type OverrideDraft,
} from "@/lib/analysis/override";
import {
  effectiveClass,
  effectiveFactors,
  effectiveTitle,
  effectiveWeights,
  parseWeights,
  presetForWeights,
  rerank,
  type Rankable,
} from "@/lib/analysis/rank";

function factors(scores: Partial<Record<(typeof FACTOR_KEYS)[number], number>> = {}): Factors {
  return Object.fromEntries(
    FACTOR_KEYS.map((k) => [k, { score: scores[k] ?? 3, rationale: `because ${k}` }]),
  ) as Factors;
}

function opp(over: Partial<Rankable & { id: string; rankScore: number }> = {}): Rankable & {
  id: string;
  rankScore: number;
} {
  return {
    id: "o1",
    title: "Invoice matching",
    solutionClass: "ai",
    factors: factors(),
    adminOverride: null,
    rankScore: 0,
    ...over,
  };
}

describe("rerank", () => {
  it("recomputes rankScore with the shared formula and sorts highest first", () => {
    const a = opp({ id: "a", title: "A", factors: factors({ expected_impact: 5, frequency: 5 }) });
    const b = opp({ id: "b", title: "B", factors: factors({ expected_impact: 1, frequency: 1 }) });
    const out = rerank([b, a], WEIGHT_PRESETS.balanced);
    expect(out.map((o) => o.id)).toEqual(["a", "b"]);
    expect(out[0]!.rankScore).toBe(rankScore(a.factors, WEIGHT_PRESETS.balanced));
    expect(out[1]!.rankScore).toBe(rankScore(b.factors, WEIGHT_PRESETS.balanced));
  });

  it("changes the order when the weights favour other factors", () => {
    const simple = opp({
      id: "simple",
      title: "Simple",
      factors: factors({ implementation_complexity: 5, expected_impact: 2, affected_employees: 2 }),
    });
    const big = opp({
      id: "big",
      title: "Big",
      factors: factors({ implementation_complexity: 1, expected_impact: 5, affected_employees: 5 }),
    });
    expect(rerank([simple, big], WEIGHT_PRESETS.quick_wins)[0]!.id).toBe("simple");
    expect(rerank([simple, big], WEIGHT_PRESETS.strategic)[0]!.id).toBe("big");
  });

  it("ranks from admin-overridden factor scores", () => {
    const base = opp({ id: "x", factors: factors({ expected_impact: 1 }) });
    const overridden = {
      ...base,
      id: "y",
      title: "Y",
      adminOverride: { factors: { expected_impact: { score: 5, rationale: "" } } },
    };
    const out = rerank([base, overridden], WEIGHT_PRESETS.balanced);
    expect(out[0]!.id).toBe("y");
    expect(effectiveFactors(overridden).expected_impact).toEqual({
      score: 5,
      rationale: "because expected_impact",
    });
    expect(effectiveFactors(base)).toBe(base.factors);
  });

  it("does not mutate its input", () => {
    const a = opp({ id: "a" });
    const before = a.rankScore;
    rerank([a], WEIGHT_PRESETS.balanced);
    expect(a.rankScore).toBe(before);
  });
});

describe("weights helpers", () => {
  it("parses a settings value tolerantly", () => {
    expect(parseWeights({ expected_impact: 2, risk: 9, junk: 4 })).toMatchObject({
      expected_impact: 2,
      risk: 5,
      frequency: 1,
    });
    expect(parseWeights(null)).toEqual(WEIGHT_PRESETS.balanced);
  });

  it("maps presets to weights and back", () => {
    expect(effectiveWeights("quick_wins", WEIGHT_PRESETS.balanced)).toBe(WEIGHT_PRESETS.quick_wins);
    const custom = { ...WEIGHT_PRESETS.balanced, risk: 3 };
    expect(effectiveWeights("custom", custom)).toBe(custom);
    expect(presetForWeights(WEIGHT_PRESETS.strategic)).toBe("strategic");
    expect(presetForWeights(custom)).toBe("custom");
  });

  it("applies title and class overrides", () => {
    const o = opp({ adminOverride: { title: "Renamed", solutionClass: "process" } });
    expect(effectiveTitle(o)).toBe("Renamed");
    expect(effectiveClass(o)).toBe("process");
    expect(effectiveTitle(opp())).toBe("Invoice matching");
    expect(effectiveClass(opp())).toBe("ai");
  });
});

describe("override reducer", () => {
  it("seeds the draft from a stored override", () => {
    expect(draftFromOverride(null)).toBe(EMPTY_DRAFT);
    expect(
      draftFromOverride({
        title: "T",
        factors: { risk: { score: 2, rationale: "regulated" } },
        note: "n",
      }),
    ).toEqual({
      title: "T",
      solutionClass: "",
      factors: { risk: { score: 2, rationale: "regulated" } },
      note: "n",
    });
  });

  it("sets, clamps and clears factor scores", () => {
    let s: OverrideDraft = EMPTY_DRAFT;
    s = overrideReducer(s, { type: "factorScore", key: "risk", score: 9 });
    expect(s.factors.risk).toEqual({ score: 5, rationale: "" });
    s = overrideReducer(s, { type: "factorRationale", key: "risk", rationale: "audited" });
    expect(s.factors.risk?.rationale).toBe("audited");
    s = overrideReducer(s, { type: "factorRationale", key: "frequency", rationale: "ignored" });
    expect(s.factors.frequency).toBeUndefined();
    s = overrideReducer(s, { type: "factorScore", key: "risk", score: null });
    expect(s.factors.risk).toBeUndefined();
    s = overrideReducer(s, { type: "title", value: "New" });
    s = overrideReducer(s, { type: "class", value: "software" });
    s = overrideReducer(s, { type: "note", value: "why" });
    expect(s).toMatchObject({ title: "New", solutionClass: "software", note: "why" });
    expect(overrideReducer(s, { type: "clear" })).toBe(EMPTY_DRAFT);
  });

  it("builds a minimal payload that omits values equal to the generated ones", () => {
    const base = opp();
    const draft: OverrideDraft = {
      title: "  Invoice matching ",
      solutionClass: "ai",
      factors: {
        risk: { score: 3, rationale: "" },
        frequency: { score: 5, rationale: "" },
        data_availability: { score: 3, rationale: "we checked" },
      },
      note: " keep ",
    };
    expect(toOverridePayload(draft, base)).toEqual({
      factors: {
        frequency: { score: 5, rationale: "because frequency" },
        data_availability: { score: 3, rationale: "we checked" },
      },
      note: "keep",
    });
    expect(toOverridePayload(EMPTY_DRAFT, base)).toEqual({});
    expect(toOverridePayload({ ...EMPTY_DRAFT, title: "Other", solutionClass: "none" }, base)).toEqual({
      title: "Other",
      solutionClass: "none",
    });
  });
});

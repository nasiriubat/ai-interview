import { describe, expect, it } from "vitest";
import { PriceTable, costCents, estimateCents } from "../src/cost/pricing.js";

describe("PriceTable", () => {
  it("prices usage from the seed table including cache reads and writes", () => {
    const t = PriceTable.withSeeds("anth");
    const p = t.get("anth", "claude-sonnet-5")!;
    // 1M input at $2, 1M cache read at $0.20, 1M cache write at 1.25 x $2, 1M output at $10
    const cents = costCents(p, { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cents).toBeCloseTo((2 + 0.2 + 2.5 + 10) * 100, 6);
  });

  it("estimates conservatively with max output tokens", () => {
    const t = PriceTable.withSeeds("anth");
    const p = t.get("anth", "claude-opus-5")!;
    expect(estimateCents(p, 1000, 2000)).toBeCloseTo(((1000 * 5 + 2000 * 25) / 1_000_000) * 100, 9);
  });

  it("imports provider-published prices but never overwrites admin overrides", () => {
    const t = new PriceTable([{ providerId: "or", model: "x/model", inputPerMtok: 9, cachedInputPerMtok: 9, outputPerMtok: 9, source: "admin" }]);
    const n = t.importFromModels("or", [
      { id: "x/model", name: "x", inputPerMtok: 1, outputPerMtok: 2 },
      { id: "y/model", name: "y", inputPerMtok: 3, outputPerMtok: 4 },
      { id: "z/nopricing", name: "z" },
    ]);
    expect(n).toBe(1);
    expect(t.get("or", "x/model")!.inputPerMtok).toBe(9);
    expect(t.get("or", "y/model")).toMatchObject({ inputPerMtok: 3, cachedInputPerMtok: 3, outputPerMtok: 4, source: "provider" });
    expect(t.get("or", "z/nopricing")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { PLANNED_PURPOSES, PURPOSES, ROUTABLE_PURPOSES, RoutablePurposeSchema } from "../src/index.js";

describe("planned purposes (D-187)", () => {
  it("stay in the enum so stored rows parse, but are not routable", () => {
    for (const p of PLANNED_PURPOSES) {
      expect(PURPOSES).toContain(p);
      expect(ROUTABLE_PURPOSES).not.toContain(p);
      expect(RoutablePurposeSchema.safeParse(p).success).toBe(false);
    }
    expect(ROUTABLE_PURPOSES).toContain("interview_turn");
    expect(ROUTABLE_PURPOSES).not.toContain("probe");
  });
});

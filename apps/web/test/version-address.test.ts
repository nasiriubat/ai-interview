import { describe, expect, it } from "vitest";
import { isVersionNumber } from "@/lib/admin/validation";

/* Simulation 2026-10-15: /versions/latest showed "Error 500" instead of a missing page. */
describe("isVersionNumber", () => {
  it("accepts a positive whole number and nothing else", () => {
    expect(isVersionNumber("1")).toBe(true);
    expect(isVersionNumber("42")).toBe(true);
    for (const v of ["0", "latest", "-1", "1.5", "01", "", "9999999"]) expect(isVersionNumber(v)).toBe(false);
  });
});

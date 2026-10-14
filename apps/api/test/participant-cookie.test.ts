import { describe, expect, it } from "vitest";
import { bearerFrom } from "../src/auth/principal.js";

/** The API reads the `__Host-` participant cookie as well as the bare one (D-263). */
describe("bearerFrom", () => {
  it("reads the __Host- participant cookie", () => {
    expect(bearerFrom(undefined, { "__Host-aidp_participant": "tok" })).toBe("pt.tok");
  });

  it("still reads the bare cookie of an earlier release, and prefers the __Host- one", () => {
    expect(bearerFrom(undefined, { aidp_participant: "old" })).toBe("pt.old");
    expect(bearerFrom(undefined, { aidp_participant: "old", "__Host-aidp_participant": "new" })).toBe(
      "pt.new",
    );
  });

  it("prefers an explicit Authorization header and falls through to the staff cookie", () => {
    expect(bearerFrom("Bearer abc", { "__Host-aidp_participant": "tok" })).toBe("abc");
    expect(bearerFrom(undefined, { "authjs.session-token": "jwt" })).toBe("jwt");
  });
});

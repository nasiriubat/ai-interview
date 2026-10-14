import { describe, expect, it } from "vitest";
import { deriveInternalSecret } from "../src/internal-secret.js";

describe("deriveInternalSecret (D-260)", () => {
  it("is deterministic, differs per secret, and is never the secret itself", () => {
    const a = deriveInternalSecret("a-session-signing-secret-of-some-length");
    expect(a).toBe(deriveInternalSecret("a-session-signing-secret-of-some-length"));
    expect(a).not.toBe(deriveInternalSecret("another-session-signing-secret-of-length"));
    expect(a).not.toContain("a-session-signing-secret");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("yields nothing for an unset secret, so an empty configuration never matches", () => {
    expect(deriveInternalSecret("")).toBe("");
  });
});

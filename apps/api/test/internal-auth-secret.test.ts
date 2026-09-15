import type * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// The point of this test is that the comparison is timing-safe, so the assertion is that
// `crypto.timingSafeEqual` is the thing doing it. Mocked before the module under test loads.
const timingSafeEqual = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual };
});

const { secretMatches } = await import("../src/modules/internal-auth/service.js");

describe("secretMatches", () => {
  const secret = "test-secret-test-secret-test-secret";

  it("compares with crypto.timingSafeEqual over fixed-length digests", () => {
    timingSafeEqual.mockClear();
    expect(secretMatches(secret, secret)).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [a, b] = timingSafeEqual.mock.calls[0] as [Buffer, Buffer];
    // Both sides are hashed first, so a wrong secret of any length still compares 32 bytes to 32.
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
  });

  it("rejects a wrong secret of the same length, a longer one, and a shorter one", () => {
    expect(secretMatches("x".repeat(secret.length), secret)).toBe(false);
    expect(secretMatches(`${secret}x`, secret)).toBe(false);
    expect(secretMatches(secret.slice(0, -1), secret)).toBe(false);
  });

  it("rejects a missing or empty credential without reaching the comparison", () => {
    timingSafeEqual.mockClear();
    expect(secretMatches(undefined, secret)).toBe(false);
    expect(secretMatches("", secret)).toBe(false);
    // An unset AUTH_SECRET must never make everything match.
    expect(secretMatches("", "")).toBe(false);
    expect(secretMatches("anything", "")).toBe(false);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });
});

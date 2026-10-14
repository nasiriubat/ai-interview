import { describe, expect, it } from "vitest";
import { authConfig } from "@/auth.config";
import { sessionMaxAgeSeconds } from "@/lib/session-lifetime";

/** A staff sign-in lasts a working day, not 30 days (D-265). */
describe("session lifetime", () => {
  it("defaults to eight hours and is what the Auth.js configuration carries", () => {
    expect(sessionMaxAgeSeconds(undefined)).toBe(8 * 3600);
    expect(sessionMaxAgeSeconds("")).toBe(8 * 3600);
    expect(authConfig.session.maxAge).toBe(8 * 3600);
    expect(authConfig.session.updateAge).toBe(3600);
  });

  it("takes an override between one hour and thirty days, and ignores nonsense", () => {
    expect(sessionMaxAgeSeconds("12")).toBe(12 * 3600);
    expect(sessionMaxAgeSeconds("0")).toBe(3600);
    expect(sessionMaxAgeSeconds("100000")).toBe(30 * 24 * 3600);
    expect(sessionMaxAgeSeconds("soon")).toBe(8 * 3600);
  });
});

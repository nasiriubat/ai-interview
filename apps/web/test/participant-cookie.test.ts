import { afterEach, describe, expect, it, vi } from "vitest";

/** The participant cookie carries the `__Host-` prefix in production (D-263). */
describe("PARTICIPANT_COOKIE", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is __Host- prefixed in production, where the cookie is Secure with Path=/", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const env = await import("@/lib/env");
    expect(env.PARTICIPANT_COOKIE).toBe("__Host-aidp_participant");
    expect(env.PARTICIPANT_COOKIE_LEGACY).toBe("aidp_participant");
  });

  it("keeps the bare name in development, where http cannot set a __Host- cookie", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();
    const env = await import("@/lib/env");
    expect(env.PARTICIPANT_COOKIE).toBe("aidp_participant");
  });
});

import { describe, expect, it } from "vitest";
import { DEV_SMTP_FALLBACK, resolveSmtpUrl } from "@/lib/auth/smtp";

describe("resolveSmtpUrl", () => {
  it("uses the configured relay whenever one is set", () => {
    expect(resolveSmtpUrl({ EMAIL_SERVER: "smtp://relay:587", NODE_ENV: "production" })).toBe(
      "smtp://relay:587",
    );
    expect(resolveSmtpUrl({ EMAIL_SERVER: "smtp://relay:587", NODE_ENV: "development" })).toBe(
      "smtp://relay:587",
    );
  });

  it("falls back to Mailpit in development and test", () => {
    expect(resolveSmtpUrl({ NODE_ENV: "development" })).toBe(DEV_SMTP_FALLBACK);
    expect(resolveSmtpUrl({ NODE_ENV: "test" })).toBe(DEV_SMTP_FALLBACK);
    expect(resolveSmtpUrl({})).toBe(DEV_SMTP_FALLBACK);
  });

  it("refuses to fall back in production, where it would black-hole every sign-in email", () => {
    expect(() => resolveSmtpUrl({ NODE_ENV: "production" })).toThrow(/EMAIL_SERVER is not set/);
  });

  // The regression this file exists for: an earlier version of the guard threw during
  // `next build`, which imports the auth module with NODE_ENV=production while collecting page
  // data. The whole web build failed on a machine that had no reason to own an SMTP relay.
  it("allows the production build phase to run without a relay", () => {
    expect(resolveSmtpUrl({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toBe(
      DEV_SMTP_FALLBACK,
    );
  });
});

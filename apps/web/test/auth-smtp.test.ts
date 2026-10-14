import { parseSmtpUrl } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { DEV_SMTP_FALLBACK, resolveSmtpUrl } from "@/lib/auth/smtp";

describe("resolveSmtpUrl", () => {
  it("composes the sign-in relay from SMTP_*, as the API and worker do (D-445)", () => {
    const password = "p@ss:w/rd #%";
    const url = resolveSmtpUrl({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "2525",
      SMTP_SECURITY: "starttls",
      SMTP_USER: "relay@example.com",
      SMTP_PASSWORD: password,
      NODE_ENV: "production",
    });
    expect(parseSmtpUrl(url)).toEqual({
      host: "smtp.example.com",
      port: 2525,
      security: "starttls",
      username: "relay@example.com",
      password,
    });
    expect(resolveSmtpUrl({ SMTP_HOST: "mail.example.com", SMTP_SECURITY: "tls" })).toBe(
      "smtps://mail.example.com:465",
    );
  });

  it("prefers SMTP_HOST over the deprecated URL variables", () => {
    const url = resolveSmtpUrl({
      SMTP_HOST: "new.example.com",
      EMAIL_SMTP_URL: "smtp://old:25",
      EMAIL_SERVER: "smtp://older:25",
      NODE_ENV: "production",
    });
    expect(new URL(url).hostname).toBe("new.example.com");
  });

  it("still uses a configured legacy relay whenever one is set (D-446)", () => {
    expect(resolveSmtpUrl({ EMAIL_SMTP_URL: "smtp://relay:587", NODE_ENV: "production" })).toBe(
      "smtp://relay:587",
    );
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
    expect(() => resolveSmtpUrl({ NODE_ENV: "production" })).toThrow(/SMTP_HOST.*EMAIL_SMTP_URL/);
    expect(() => resolveSmtpUrl({ NODE_ENV: "production", SMTP_HOST: "", EMAIL_SERVER: "" })).toThrow(
      /SMTP_HOST/,
    );
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

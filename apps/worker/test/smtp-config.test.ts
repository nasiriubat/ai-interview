import { resolveSmtpEnv } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgresql://x", PLATFORM_ENCRYPTION_KEY: "k" };

describe("the deployment mail relay in the worker config (D-445..D-448)", () => {
  it("resolves with the shared rule the API and the web app use", () => {
    const envs: Record<string, string>[] = [
      { SMTP_HOST: "smtp.example.com", SMTP_USER: "u@x", SMTP_PASSWORD: "p@ss:/# %" },
      { SMTP_HOST: "mail.example.com", SMTP_SECURITY: "tls" },
      { SMTP_HOST: "mailpit", SMTP_PORT: "1025", SMTP_SECURITY: "none" },
      { EMAIL_SMTP_URL: "smtp://legacy.example.com:587" },
      { SMTP_HOST: "new.example.com", EMAIL_SMTP_URL: "smtp://legacy.example.com:587" },
    ];
    for (const env of envs) {
      const shared = resolveSmtpEnv(env);
      expect(shared.source).not.toBe("none");
      expect(loadConfig({ ...base, ...env }).smtpRelayUrl).toBe(
        shared.source === "none" ? undefined : shared.url,
      );
    }
    expect(
      loadConfig({ ...base, SMTP_HOST: "mailpit", SMTP_PORT: "1025", SMTP_SECURITY: "none" }).smtpRelayUrl,
    ).toBe("smtp://mailpit:1025?ignoreTLS=true");
    expect(loadConfig({ ...base }).smtpRelayUrl).toBeUndefined();
  });

  it("refuses to start in production without a relay", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/SMTP_HOST/);
    expect(loadConfig({ ...base, NODE_ENV: "production", EMAIL_SMTP_URL: "smtp://r:25" }).smtpRelayUrl).toBe(
      "smtp://r:25",
    );
  });

  it("refuses an unusable value at start rather than at the first send", () => {
    expect(() => loadConfig({ ...base, SMTP_HOST: "smtp.example.com", SMTP_PORT: "0" })).toThrow(/SMTP_PORT/);
  });
});

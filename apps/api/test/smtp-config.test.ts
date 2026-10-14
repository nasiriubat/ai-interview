import { parseSmtpUrl } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "postgresql://x",
  PLATFORM_ENCRYPTION_KEY: "k",
  AUTH_SECRET: "0123456789abcdef0123",
};

describe("the deployment mail relay in the API config (D-445..D-448)", () => {
  it("composes SMTP_* into the relay, credentials taken literally", () => {
    const password = "a@b:c/d#e%f g";
    const c = loadConfig({
      ...base,
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_SECURITY: "starttls",
      SMTP_USER: "apikey",
      SMTP_PASSWORD: password,
    });
    expect(parseSmtpUrl(c.smtpRelayUrl ?? "")).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "apikey",
      password,
    });
  });

  it("falls back to the deprecated EMAIL_SMTP_URL, and SMTP_HOST wins over it", () => {
    expect(loadConfig({ ...base, EMAIL_SMTP_URL: "smtp://old:25" }).smtpRelayUrl).toBe("smtp://old:25");
    const both = loadConfig({ ...base, EMAIL_SMTP_URL: "smtp://old:25", SMTP_HOST: "new.example.com" });
    expect(new URL(both.smtpRelayUrl ?? "").hostname).toBe("new.example.com");
  });

  it("has no relay in development when nothing is set (mail is logged)", () => {
    expect(loadConfig({ ...base, SMTP_HOST: "", EMAIL_SMTP_URL: "" }).smtpRelayUrl).toBeUndefined();
  });

  it("refuses to start in production with neither SMTP_HOST nor EMAIL_SMTP_URL", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", SMTP_HOST: "", EMAIL_SMTP_URL: "" })).toThrow(
      /SMTP_HOST.*EMAIL_SMTP_URL/,
    );
    expect(loadConfig({ ...base, NODE_ENV: "production", SMTP_HOST: "smtp.example.com" }).smtpRelayUrl).toBe(
      "smtp://smtp.example.com:587?requireTLS=true",
    );
  });

  it("names the variable that is wrong, not its value", () => {
    expect(() => loadConfig({ ...base, SMTP_HOST: "smtp.example.com", SMTP_SECURITY: "yes" })).toThrow(
      /Invalid configuration: SMTP_SECURITY/,
    );
    let message = "";
    try {
      loadConfig({ ...base, SMTP_PASSWORD: "s3cret-value" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/SMTP_HOST is empty/);
    expect(message).not.toContain("s3cret-value");
  });
});

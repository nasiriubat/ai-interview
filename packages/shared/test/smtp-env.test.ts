import { describe, expect, it } from "vitest";
import { parseSmtpUrl, resolveSmtpEnv, SmtpEnvError, type SmtpEnvRelay } from "../src/index.js";

const url = (r: SmtpEnvRelay): string => {
  if (r.source === "none") throw new Error("expected a relay");
  return r.url;
};

describe("resolveSmtpEnv (D-445, D-446)", () => {
  it("is none when nothing is set, and treats empty strings as unset", () => {
    expect(resolveSmtpEnv({})).toEqual({ source: "none" });
    expect(
      resolveSmtpEnv({
        SMTP_HOST: "",
        SMTP_PORT: "",
        SMTP_SECURITY: "",
        SMTP_USER: "",
        SMTP_PASSWORD: "",
        EMAIL_SMTP_URL: "",
      }),
    ).toEqual({ source: "none" });
    // SMTP_SECURITY alone is a default someone left in place, not a half-configured relay.
    expect(resolveSmtpEnv({ SMTP_SECURITY: "starttls" })).toEqual({ source: "none" });
  });

  it("composes the relay from the split variables", () => {
    const r = resolveSmtpEnv({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_SECURITY: "starttls",
      SMTP_USER: "apikey",
      SMTP_PASSWORD: "secret",
    });
    expect(r.source).toBe("smtp_vars");
    expect(url(r)).toBe("smtp://apikey:secret@smtp.example.com:587?requireTLS=true");
  });

  it("takes credentials with special characters literally; nobody URL-encodes anything", () => {
    const password = "p@ss:w/rd#1 %20 & more ";
    const user = "relay@example.com";
    const r = resolveSmtpEnv({ SMTP_HOST: "smtp.example.com", SMTP_USER: user, SMTP_PASSWORD: password });
    const parsed = parseSmtpUrl(url(r));
    expect(parsed).toMatchObject({ host: "smtp.example.com", port: 587, username: user, password });
    // The composed URL has exactly one authority separator, so the host cannot be mistaken.
    expect(new URL(url(r)).hostname).toBe("smtp.example.com");
  });

  it("defaults the security to starttls and the port from the security", () => {
    const at = (SMTP_SECURITY?: string) =>
      parseSmtpUrl(
        url(resolveSmtpEnv({ SMTP_HOST: "mail.example.com", ...(SMTP_SECURITY ? { SMTP_SECURITY } : {}) })),
      );
    expect(at()).toMatchObject({ security: "starttls", port: 587 });
    expect(at("starttls")).toMatchObject({ security: "starttls", port: 587 });
    expect(at("tls")).toMatchObject({ security: "ssl", port: 465 });
    expect(at("TLS")).toMatchObject({ security: "ssl", port: 465 });
    expect(at("ssl")).toMatchObject({ security: "ssl", port: 465 });
    expect(at("none")).toMatchObject({ security: "none", port: 25 });
    expect(url(resolveSmtpEnv({ SMTP_HOST: "mail.example.com", SMTP_SECURITY: "tls" }))).toMatch(
      /^smtps:\/\//,
    );
    expect(url(resolveSmtpEnv({ SMTP_HOST: "mailpit", SMTP_PORT: "1025", SMTP_SECURITY: "none" }))).toBe(
      "smtp://mailpit:1025?ignoreTLS=true",
    );
  });

  it("prefers the split variables over the legacy URL", () => {
    const r = resolveSmtpEnv({ SMTP_HOST: "new.example.com", EMAIL_SMTP_URL: "smtp://old.example.com:25" });
    expect(r.source).toBe("smtp_vars");
    expect(new URL(url(r)).hostname).toBe("new.example.com");
  });

  it("still accepts the deprecated EMAIL_SMTP_URL, as written", () => {
    const legacy = "smtp://u%40x:p%40ss@relay.example.com:587";
    expect(resolveSmtpEnv({ EMAIL_SMTP_URL: legacy })).toEqual({ source: "legacy_url", url: legacy });
  });

  it("refuses an unusable configuration and names variables, never values", () => {
    const secret = "hunter2-do-not-print";
    const cases: [Record<string, string>, RegExp][] = [
      [{ SMTP_HOST: "smtp.example.com", SMTP_PORT: "abc" }, /SMTP_PORT/],
      [{ SMTP_HOST: "smtp.example.com", SMTP_PORT: "70000" }, /SMTP_PORT/],
      [{ SMTP_HOST: "smtp.example.com", SMTP_SECURITY: "maybe" }, /SMTP_SECURITY/],
      [{ SMTP_HOST: "smtp://smtp.example.com" }, /SMTP_HOST/],
      [{ SMTP_HOST: "smtp.example.com", SMTP_PASSWORD: secret }, /SMTP_USER is empty/],
      [{ SMTP_USER: "u", SMTP_PASSWORD: secret }, /SMTP_USER, SMTP_PASSWORD are set but SMTP_HOST is empty/],
      [{ EMAIL_SMTP_URL: `https://u:${secret}@x` }, /EMAIL_SMTP_URL/],
    ];
    for (const [env, message] of cases) {
      let thrown: unknown;
      try {
        resolveSmtpEnv(env);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SmtpEnvError);
      expect((thrown as Error).message).toMatch(message);
      expect((thrown as Error).message).not.toContain(secret);
    }
  });
});

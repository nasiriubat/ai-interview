import { describe, expect, it } from "vitest";
import {
  composeSmtpUrl,
  isSmtpUrl,
  parseSmtpUrl,
  smtpUrlFromForm,
  summariseSmtpUrl,
  type SmtpParts,
} from "../src/index.js";

const sample: SmtpParts = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "apikey",
  password: "p@ss:w/ord#1 %&?",
};

describe("smtp url composition", () => {
  it("round-trips every security mode and awkward credentials", () => {
    for (const security of ["starttls", "ssl", "none"] as const) {
      const parts = { ...sample, security, port: security === "ssl" ? 465 : 587 };
      const url = composeSmtpUrl(parts);
      expect(isSmtpUrl(url)).toBe(true);
      expect(parseSmtpUrl(url)).toEqual(parts);
    }
  });

  it("percent-encodes credentials so the host is never confused", () => {
    const url = composeSmtpUrl({ ...sample, username: "me@corp.com" });
    expect(new URL(url).hostname).toBe("smtp.example.com");
    expect(url).toContain("me%40corp.com");
  });

  it("omits credentials when there is no username", () => {
    expect(composeSmtpUrl({ ...sample, username: "", password: "" })).toBe(
      "smtp://smtp.example.com:587?requireTLS=true",
    );
    expect(parseSmtpUrl(composeSmtpUrl({ ...sample, password: "" }))?.password).toBe("");
  });

  it("parses a legacy value without options as STARTTLS, and defaults ports", () => {
    expect(parseSmtpUrl("smtp://u:p@host.test")).toMatchObject({ port: 587, security: "starttls" });
    expect(parseSmtpUrl("smtps://host.test")).toMatchObject({ port: 465, security: "ssl" });
    expect(parseSmtpUrl("http://host.test")).toBeNull();
  });

  it("rejects an invalid host or port", () => {
    expect(() => composeSmtpUrl({ ...sample, host: "bad host" })).toThrow();
    expect(() => composeSmtpUrl({ ...sample, host: "evil.com/x@y" })).toThrow();
    expect(() => composeSmtpUrl({ ...sample, port: 70000 })).toThrow();
  });

  it("summarises without ever returning the password", () => {
    const summary = summariseSmtpUrl(composeSmtpUrl(sample));
    expect(summary).toEqual({
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "apikey",
      passwordSet: true,
    });
    expect(JSON.stringify(summary)).not.toContain("p@ss");
  });

  it("keeps the stored password when unchanged, replaces or removes it otherwise", () => {
    const stored = composeSmtpUrl(sample);
    const base = { host: "other.example.com", port: 465, security: "ssl" as const, username: "apikey" };
    expect(parseSmtpUrl(smtpUrlFromForm({ ...base, password: "__unchanged__" }, stored))?.password).toBe(
      sample.password,
    );
    expect(parseSmtpUrl(smtpUrlFromForm({ ...base, password: "new" }, stored))?.password).toBe("new");
    expect(parseSmtpUrl(smtpUrlFromForm({ ...base, password: null }, stored))?.password).toBe("");
  });
});

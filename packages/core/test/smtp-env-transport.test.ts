import { resolveSmtpEnv } from "@aidp/shared";
import nodemailer from "nodemailer";
import { describe, expect, it } from "vitest";

// The split SMTP_* variables become a URL only to reach Nodemailer (D-445). This holds the far
// side of that contract: what Nodemailer reads back is what the operator typed. No connection is
// made; the transport is only constructed.
describe("SMTP_* through Nodemailer", () => {
  const options = (env: Record<string, string>) => {
    const relay = resolveSmtpEnv(env);
    if (relay.source === "none") throw new Error("expected a relay");
    // The parsed connection options, which the public types do not describe.
    return Reflect.get(nodemailer.createTransport(relay.url), "options") as {
      host: string;
      port: number;
      secure: boolean;
      requireTLS?: boolean;
      ignoreTLS?: boolean;
      auth?: { user: string; pass: string };
    };
  };

  it("hands Nodemailer the credentials exactly as written", () => {
    const pass = "p@ss:w/rd#1 %41 &?= x";
    const o = options({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_SECURITY: "starttls",
      SMTP_USER: "relay@example.com",
      SMTP_PASSWORD: pass,
    });
    expect(o.host).toBe("smtp.example.com");
    expect(o.port).toBe(587);
    expect(o.secure).toBe(false);
    expect(o.requireTLS).toBe(true);
    expect(o.auth).toEqual({ user: "relay@example.com", pass });
  });

  it("maps each security mode onto Nodemailer's options", () => {
    expect(options({ SMTP_HOST: "mail.example.com", SMTP_SECURITY: "tls" })).toMatchObject({
      port: 465,
      secure: true,
    });
    expect(options({ SMTP_HOST: "mailpit", SMTP_PORT: "1025", SMTP_SECURITY: "none" })).toMatchObject({
      port: 1025,
      secure: false,
      ignoreTLS: true,
    });
  });
});

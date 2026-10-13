import { randomBytes } from "node:crypto";
import { describeDb } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Crypto } from "../src/crypto.js";
import { MemoryEmail, type EmailMessage, type EmailPort } from "../src/email/port.js";
import { SettingsEmail } from "../src/email/settings-email.js";
import { SettingsService } from "../src/settings/service.js";

const suite = describeDb;

/** Stands in for SmtpEmail so nothing opens a socket; records which URL it was built for. */
class FakeTransport implements EmailPort {
  readonly sent: EmailMessage[] = [];
  constructor(readonly url: string) {}
  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m);
  }
}

suite("SettingsEmail", () => {
  const db = new PrismaClient();
  const settings = new SettingsService(db, new Crypto(randomBytes(32).toString("base64")));
  const tenant = `t_email_${Date.now()}`;
  const keys = ["email.smtpUrl", "email.from", "email.replyTo", "branding.emailSender"];

  const cleanup = () =>
    db.setting.deleteMany({
      where: { OR: [{ scope: "platform", key: { in: keys } }, { scopeId: tenant }] },
    });

  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  const build = () => {
    const built: FakeTransport[] = [];
    const fallback = new MemoryEmail();
    const email = new SettingsEmail({
      settings,
      env: { smtpUrl: "smtp://env.test", from: "env@test.io" },
      fallback,
      transportFor: (url) => {
        const t = new FakeTransport(url);
        built.push(t);
        return t;
      },
    });
    return { email, built, fallback };
  };

  it("prefers the tenant, then the platform, then the environment, and caches one transport per URL", async () => {
    const { email, built } = build();

    // Nothing configured: the environment wins.
    expect(await email.resolve(tenant)).toMatchObject({ smtpUrl: "smtp://env.test", usedScope: "env" });

    await settings.set({ scope: "platform", scopeId: "" }, { "email.smtpUrl": "smtp://platform.test" }, null);
    expect(await email.resolve(tenant)).toMatchObject({
      smtpUrl: "smtp://platform.test",
      usedScope: "platform",
    });

    await settings.set(
      { scope: "tenant", scopeId: tenant },
      { "email.smtpUrl": "smtp://tenant.test", "email.from": "hello@tenant.test" },
      "u1",
    );
    const resolved = await email.resolve(tenant);
    expect(resolved).toMatchObject({
      smtpUrl: "smtp://tenant.test",
      from: "hello@tenant.test",
      usedScope: "tenant",
    });

    // A message without a tenant still resolves the platform configuration.
    expect(await email.resolve()).toMatchObject({
      smtpUrl: "smtp://platform.test",
      usedScope: "platform",
    });

    await email.send({ to: "a@test.io", subject: "s", text: "t", companyId: tenant });
    await email.send({ to: "b@test.io", subject: "s", text: "t", companyId: tenant });
    expect(built).toHaveLength(1);
    expect(built[0]?.url).toBe("smtp://tenant.test");
    expect(built[0]?.sent).toHaveLength(2);
    expect(built[0]?.sent[0]?.from).toBe("hello@tenant.test");

    // Changing the URL invalidates the cached transport.
    await settings.set({ scope: "tenant", scopeId: tenant }, { "email.smtpUrl": "smtp://other.test" }, "u1");
    await email.send({ to: "c@test.io", subject: "s", text: "t", companyId: tenant });
    expect(built.map((t) => t.url)).toEqual(["smtp://tenant.test", "smtp://other.test"]);
  });

  it("falls back to branding.emailSender and to the console when nothing is configured", async () => {
    await cleanup();
    const { email, fallback } = build();
    const noSmtp = new SettingsEmail({
      settings,
      env: { from: "env@test.io" },
      fallback,
    });
    await settings.set(
      { scope: "tenant", scopeId: tenant },
      { "branding.emailSender": "legacy@tenant.test" },
      "u1",
    );
    expect(await email.resolve(tenant)).toMatchObject({ from: "legacy@tenant.test" });

    await noSmtp.send({ to: "d@test.io", subject: "s", text: "t", companyId: tenant });
    expect(fallback.sent).toHaveLength(1);
    expect(fallback.sent[0]?.from).toBe("legacy@tenant.test");
  });
});

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crypto } from "../src/crypto.js";
import { MemoryEmail } from "../src/email/port.js";
import { SettingsEmail } from "../src/email/settings-email.js";
import { SmtpEmail } from "../src/email/smtp.js";
import { EgressBlockedError, EgressGuard } from "../src/net/egress.js";
import { SettingsService } from "../src/settings/service.js";

/** A minimal SMTP server: records connections and the message body it is given. */
function fakeSmtp(): Promise<{
  server: Server;
  port: number;
  connections: () => number;
  mail: () => string;
}> {
  return new Promise((resolve) => {
    let connections = 0;
    let delivered = "";
    const server = createServer((socket) => {
      connections++;
      let inData = false;
      let data = "";
      socket.write("220 fake ESMTP\r\n");
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        if (inData) {
          data += text;
          if (data.endsWith("\r\n.\r\n")) {
            inData = false;
            delivered = data;
            socket.write("250 queued\r\n");
          }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "DATA") {
            inData = true;
            socket.write("354 go\r\n");
          } else if (cmd === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else socket.write("250 ok\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        port: typeof addr === "object" && addr ? addr.port : 0,
        connections: () => connections,
        mail: () => delivered,
      });
    });
  });
}

const suite = process.env.DATABASE_URL ? describe : describe.skip;

describe("SmtpEmail delivery through nodemailer", () => {
  it("delivers a message to a relay from the environment, unguarded", async () => {
    const relay = await fakeSmtp();
    try {
      const email = new SmtpEmail(`smtp://127.0.0.1:${relay.port}`, "from@example.test");
      await email.send({ to: "person@example.test", subject: "Hello", text: "Body text" });
      email.close();
      expect(relay.mail()).toMatch(/^Subject: Hello/im);
      expect(relay.mail()).toContain("Body text");
    } finally {
      relay.server.close();
    }
  });

  it("dials the validated address of a guarded relay and keeps the name for TLS", async () => {
    const relay = await fakeSmtp();
    try {
      const guard = new EgressGuard(
        { mode: "strict", allowHosts: ["relay.internal"] },
        { resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
      );
      const email = new SmtpEmail(`smtp://relay.internal:${relay.port}`, "from@example.test", {
        egress: guard,
        origin: "platform",
      });
      await email.send({ to: "person@example.test", subject: "Guarded", text: "via the allowlist" });
      expect(relay.mail()).toContain("via the allowlist");
    } finally {
      relay.server.close();
    }
  });

  it("never opens a connection for a tenant relay that resolves inside", async () => {
    const relay = await fakeSmtp();
    try {
      const guard = new EgressGuard(
        { mode: "strict", allowHosts: [] },
        { resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
      );
      const email = new SmtpEmail("smtps://mail.attacker.example", "from@example.test", {
        egress: guard,
        origin: "tenant",
      });
      await expect(email.send({ to: "a@b.test", subject: "s", text: "t" })).rejects.toBeInstanceOf(
        EgressBlockedError,
      );
      expect(relay.connections()).toBe(0);
    } finally {
      relay.server.close();
    }
  });

  it("refuses to construct a tenant transport for a loopback literal", () => {
    const guard = new EgressGuard({ mode: "strict", allowHosts: [] });
    expect(
      () => new SmtpEmail("smtp://127.0.0.1:587", "f@example.test", { egress: guard, origin: "tenant" }),
    ).toThrow(EgressBlockedError);
  });
});

suite("SettingsEmail applies the policy by where the relay was configured", () => {
  const db = new PrismaClient();
  const settings = new SettingsService(db, new Crypto(randomBytes(32).toString("base64")));
  const tenant = `t_smtp_${Date.now()}`;
  let relay: Awaited<ReturnType<typeof fakeSmtp>>;

  beforeAll(async () => {
    relay = await fakeSmtp();
    await db.setting.deleteMany({
      where: { OR: [{ scope: "platform", key: "email.smtpUrl" }, { scopeId: tenant }] },
    });
  });
  afterAll(async () => {
    await db.setting.deleteMany({
      where: { OR: [{ scope: "platform", key: "email.smtpUrl" }, { scopeId: tenant }] },
    });
    await db.$disconnect();
    relay.server.close();
  });

  it("refuses a stored tenant relay that points at loopback, without connecting", async () => {
    // Written past the route, as an old row or a direct write would be.
    await settings.set(
      { scope: "tenant", scopeId: tenant },
      { "email.smtpUrl": `smtp://127.0.0.1:${relay.port}` },
      null,
    );
    const guard = new EgressGuard({ mode: "strict", allowHosts: [] });
    const email = new SettingsEmail({
      settings,
      env: { from: "env@test.io" },
      fallback: new MemoryEmail(),
      egress: guard,
    });
    await expect(
      email.send({ to: "a@b.test", subject: "s", text: "t", companyId: tenant }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(relay.connections()).toBe(0);
  });

  it("leaves the deployment's own relay (environment) unguarded", async () => {
    const guard = new EgressGuard({ mode: "strict", allowHosts: [] });
    const email = new SettingsEmail({
      settings,
      env: { smtpUrl: `smtp://127.0.0.1:${relay.port}`, from: "env@test.io" },
      fallback: new MemoryEmail(),
      egress: guard,
    });
    await db.setting.deleteMany({ where: { scopeId: tenant } });
    await email.send({ to: "a@b.test", subject: "Env relay", text: "t", companyId: tenant });
    expect(relay.mail()).toMatch(/^Subject: Env relay/im);
    expect(relay.connections()).toBeGreaterThan(0);
  });
});

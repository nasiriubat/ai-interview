import type { Server as HttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { parseSmtpUrl, SMTP_PASSWORD_UNCHANGED } from "@aidp/shared";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/** A relay on loopback that either accepts, or rejects AUTH with 535. */
function fakeRelay(rejectAuth: boolean): Promise<{ server: Server; port: number; mail: () => string }> {
  return new Promise((resolve) => {
    let delivered = "";
    const server = createServer((socket) => {
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
          if (cmd === "EHLO") socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (cmd === "AUTH") socket.write(rejectAuth ? "535 5.7.8 nope\r\n" : "235 ok\r\n");
          else if (cmd === "DATA") {
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
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, mail: () => delivered });
    });
  });
}

describeDb("structured SMTP settings and the test send (D-410 to D-413)", () => {
  let world: TestWorld;
  let model: { server: HttpServer; url: string; requests: unknown[] };
  let admin: { authorization: string };

  beforeAll(async () => {
    model = await fakeModelServer(() => "ready");
    world = await testWorld(model.url);
    admin = { authorization: `Bearer ${world.adminToken}` };
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const put = (payload: Record<string, unknown>) =>
    world.app.inject({ method: "PUT", url: "/api/v1/settings?scope=tenant", headers: admin, payload });
  const get = () => world.app.inject({ method: "GET", url: "/api/v1/settings?scope=tenant", headers: admin });
  const test = (payload: Record<string, unknown>) =>
    world.app.inject({ method: "POST", url: "/api/v1/settings/email/test", headers: admin, payload });
  const stored = async (): Promise<string> => {
    const row = await world.db.setting.findFirstOrThrow({
      where: { scope: "tenant", scopeId: world.companyId, key: "email.smtpUrl" },
    });
    return world.crypto.decrypt(row.value as string, "setting.secret");
  };

  it("reports no relay at all before anything is set", async () => {
    const body = (await get()).json<{ smtp: { set: unknown; effective: string; envConfigured: boolean } }>();
    expect(body.smtp).toEqual({ set: null, effective: "none", envConfigured: false });
  });

  it("composes the structured form into the one secret string and never reads the password back", async () => {
    const res = await put({
      values: {},
      smtp: {
        host: "smtp.mailer.example",
        port: 587,
        security: "starttls",
        username: "me@corp.example",
        password: "p@ss:w/rd#9",
      },
    });
    expect(res.statusCode).toBe(200);
    const parts = parseSmtpUrl(await stored());
    expect(parts).toEqual({
      host: "smtp.mailer.example",
      port: 587,
      security: "starttls",
      username: "me@corp.example",
      password: "p@ss:w/rd#9",
    });

    const read = await get();
    expect(read.body).not.toContain("p@ss");
    expect(read.body).not.toContain("p%40ss");
    expect(read.json<{ smtp: unknown }>().smtp).toEqual({
      set: {
        host: "smtp.mailer.example",
        port: 587,
        security: "starttls",
        username: "me@corp.example",
        passwordSet: true,
      },
      effective: "tenant",
      envConfigured: false,
    });
  });

  it("keeps the stored password when only the host changes, and can remove it", async () => {
    await put({
      values: {},
      smtp: {
        host: "other.mailer.example",
        port: 465,
        security: "ssl",
        username: "me@corp.example",
        password: SMTP_PASSWORD_UNCHANGED,
      },
    });
    expect(parseSmtpUrl(await stored())).toMatchObject({
      host: "other.mailer.example",
      security: "ssl",
      password: "p@ss:w/rd#9",
    });
    await put({
      values: {},
      smtp: {
        host: "other.mailer.example",
        port: 465,
        security: "ssl",
        username: "me@corp.example",
        password: null,
      },
    });
    expect(parseSmtpUrl(await stored())?.password).toBe("");
  });

  it("refuses both forms at once, a bad host, and a relay the egress policy forbids", async () => {
    const both = await put({
      values: { "email.smtpUrl": "smtp://a.example:587" },
      smtp: { host: "b.example", port: 587, security: "starttls", username: "", password: null },
    });
    expect(both.statusCode).toBe(400);
    const badHost = await put({
      values: {},
      smtp: { host: "bad host/../x", port: 587, security: "starttls", username: "", password: null },
    });
    expect(badHost.statusCode).toBe(400);
    const badPort = await put({
      values: {},
      smtp: { host: "ok.example", port: 99999, security: "starttls", username: "", password: null },
    });
    expect(badPort.statusCode).toBe(400);
  });

  it("tests the unsaved form against a fake relay and delivers to the admin", async () => {
    const relay = await fakeRelay(false);
    try {
      const saved = await stored();
      const res = await test({
        scope: "tenant",
        smtp: { host: "127.0.0.1", port: relay.port, security: "none", username: "", password: null },
        from: "hello@tenant.example",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, usedScope: "tenant" });
      expect(relay.mail()).toContain(world.adminEmail);
      expect(relay.mail()).toContain("hello@tenant.example");
      // Nothing was saved by testing.
      expect(await stored()).toBe(saved);
    } finally {
      relay.server.close();
    }
  });

  it("names an authentication failure in plain words without echoing the password", async () => {
    const relay = await fakeRelay(true);
    try {
      const res = await test({
        scope: "tenant",
        smtp: {
          host: "127.0.0.1",
          port: relay.port,
          security: "none",
          username: "user",
          password: "SuperSecretPw!",
        },
      });
      const body = res.json<{ ok: boolean; errorClass: string; error: string }>();
      expect(body).toMatchObject({ ok: false, errorClass: "auth_failed" });
      expect(body.error).toMatch(/username or password/i);
      expect(res.body).not.toContain("SuperSecretPw");
      const entry = await world.db.auditLog.findFirstOrThrow({
        where: { companyId: world.companyId, action: "settings.email_test" },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.stringify(entry.diff)).toContain("auth_failed");
      expect(JSON.stringify(entry.diff)).not.toContain("SuperSecretPw");
    } finally {
      relay.server.close();
    }
  });

  it("says the connection was refused when nothing listens", async () => {
    const relay = await fakeRelay(false);
    const { port } = relay;
    await new Promise<void>((r) =>
      relay.server.close(() => {
        r();
      }),
    );
    const res = await test({
      scope: "tenant",
      smtp: { host: "127.0.0.1", port, security: "none", username: "", password: null },
    });
    expect(res.json()).toMatchObject({ ok: false, errorClass: "connection_refused" });
  });

  it("answers 429 once the budget for test sends is spent", async () => {
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await test({
        scope: "tenant",
        smtp: { host: "127.0.0.1", port: 1, security: "none", username: "", password: null },
      });
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

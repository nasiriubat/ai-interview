import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { classifySmtpError, SMTP_ERROR_MESSAGES } from "../src/email/smtp-errors.js";
import { sendTestMessage } from "../src/email/test-send.js";
import { EgressBlockedError, EgressGuard } from "../src/net/egress.js";

type Behaviour = "ok" | "reject-auth" | "silent";

/** A minimal SMTP server whose behaviour is chosen per test. No network beyond loopback. */
function fakeSmtp(behaviour: Behaviour): Promise<{ server: Server; port: number; mail: () => string }> {
  return new Promise((resolve) => {
    let delivered = "";
    const server = createServer((socket) => {
      if (behaviour === "silent") {
        socket.on("error", () => undefined);
        return;
      }
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
          else if (cmd === "AUTH") {
            if (behaviour === "reject-auth") socket.write("535 5.7.8 Authentication failed\r\n");
            else socket.write("235 ok\r\n");
          } else if (cmd === "DATA") {
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

const guard = (): EgressGuard =>
  new EgressGuard(
    { mode: "strict", allowHosts: ["relay.internal"] },
    { resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
  );

const base = {
  from: "no-reply@example.test",
  to: "admin@example.test",
  subject: "Test",
  text: "hello from the test",
  origin: "platform" as const,
  timeoutMs: 600,
};

const open: Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe("sendTestMessage", () => {
  it("delivers through a saved-or-unsaved relay and reports ok", async () => {
    const relay = await fakeSmtp("ok");
    open.push(relay.server);
    const result = await sendTestMessage({
      ...base,
      egress: guard(),
      url: `smtp://relay.internal:${relay.port}`,
    });
    expect(result).toEqual({ ok: true });
    expect(relay.mail()).toContain("hello from the test");
  });

  it("says auth failed when the server rejects the credentials", async () => {
    const relay = await fakeSmtp("reject-auth");
    open.push(relay.server);
    const result = await sendTestMessage({
      ...base,
      egress: guard(),
      url: `smtp://user:wrong@relay.internal:${relay.port}`,
    });
    expect(result).toMatchObject({ ok: false, errorClass: "auth_failed" });
    if (!result.ok) expect(result.message).toBe(SMTP_ERROR_MESSAGES.auth_failed);
  });

  it("says connection refused when nothing listens on the port", async () => {
    const relay = await fakeSmtp("ok");
    const { port } = relay;
    await new Promise<void>((r) => {
      relay.server.close(() => {
        r();
      });
    });
    const result = await sendTestMessage({
      ...base,
      egress: guard(),
      url: `smtp://relay.internal:${port}`,
    });
    expect(result).toMatchObject({ ok: false, errorClass: "connection_refused" });
  });

  it("says timeout when the server accepts and never greets", async () => {
    const relay = await fakeSmtp("silent");
    open.push(relay.server);
    const result = await sendTestMessage({
      ...base,
      egress: guard(),
      url: `smtp://relay.internal:${relay.port}`,
      timeoutMs: 300,
    });
    expect(result).toMatchObject({ ok: false, errorClass: "timeout" });
  });

  it("says TLS failed when SSL/TLS is chosen against a plain-text port", async () => {
    const relay = await fakeSmtp("ok");
    open.push(relay.server);
    const result = await sendTestMessage({
      ...base,
      egress: guard(),
      url: `smtps://relay.internal:${relay.port}`,
    });
    expect(result).toMatchObject({ ok: false, errorClass: "tls_failed" });
  });

  it("applies the egress policy before dialling and never connects", async () => {
    const relay = await fakeSmtp("ok");
    open.push(relay.server);
    const strict = new EgressGuard(
      { mode: "strict", allowHosts: [] },
      { resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
    );
    const result = await sendTestMessage({
      ...base,
      egress: strict,
      origin: "tenant",
      url: `smtp://mail.attacker.example:${relay.port}`,
    });
    expect(result).toMatchObject({ ok: false, errorClass: "blocked" });
    expect(relay.mail()).toBe("");
  });

  it("carries no part of the connection string in the result", async () => {
    const relay = await fakeSmtp("reject-auth");
    open.push(relay.server);
    const result = await sendTestMessage({
      ...base,
      egress: guard(),
      url: `smtp://user:topsecretpw@relay.internal:${relay.port}`,
    });
    if (result.ok) throw new Error("expected failure");
    expect(JSON.stringify({ ...result, cause: undefined })).not.toContain("topsecretpw");
  });
});

describe("classifySmtpError", () => {
  it("maps codes and messages to classes", () => {
    expect(classifySmtpError(Object.assign(new Error("x"), { code: "EAUTH" }))).toBe("auth_failed");
    expect(classifySmtpError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(classifySmtpError(new Error("connect ECONNREFUSED 1.2.3.4:25"))).toBe("connection_refused");
    expect(classifySmtpError(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe("host_not_found");
    expect(classifySmtpError(new Error("wrong version number"))).toBe("tls_failed");
    expect(classifySmtpError(new EgressBlockedError("private_address"))).toBe("blocked");
    expect(classifySmtpError(new Error("???"))).toBe("unknown");
  });
});

// @vitest-environment node
import { createServer, type Server } from "node:net";
import Nodemailer from "next-auth/providers/nodemailer";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The sign-in round trip through the installed nodemailer (D-85). next-auth declares a peer range
 * that stops at nodemailer 8; the security upgrade runs 10.x through a pnpm override, so this test
 * is what proves the pair still delivers a magic link. It talks to a tiny in-process SMTP server
 * on loopback, never the network.
 */
function fakeSmtp(): Promise<{ server: Server; port: number; mail: Promise<string> }> {
  return new Promise((resolve) => {
    let deliver!: (raw: string) => void;
    const mail = new Promise<string>((r) => (deliver = r));
    const server = createServer((socket) => {
      let inData = false;
      let data = "";
      socket.write("220 fake ESMTP\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString();
        if (inData) {
          data += text;
          if (data.endsWith("\r\n.\r\n")) {
            inData = false;
            socket.write("250 queued\r\n");
            deliver(data);
          }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") socket.write("250 fake\r\n");
          else if (cmd === "MAIL" || cmd === "RCPT") socket.write("250 ok\r\n");
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
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, mail });
    });
  });
}

let open: Server | undefined;
afterEach(() => {
  open?.close();
});

describe("magic-link delivery", () => {
  it("sends the sign-in link through nodemailer to the configured relay", async () => {
    const smtp = await fakeSmtp();
    open = smtp.server;
    const provider = Nodemailer({
      server: `smtp://127.0.0.1:${smtp.port}`,
      from: "no-reply@example.test",
    });
    const url = "https://example.test/api/auth/callback/nodemailer?token=abc123&email=a%40b.test";
    await provider.sendVerificationRequest({
      identifier: "person@example.test",
      url,
      expires: new Date(Date.now() + 600_000),
      token: "abc123",
      provider: { ...provider, ...provider.options },
      theme: {},
      request: new Request("https://example.test"),
    });
    const raw = await smtp.mail;
    expect(raw).toMatch(/^To: person@example\.test/im);
    expect(raw).toMatch(/^From: .*no-reply@example\.test/im);
    // Quoted-printable may soft-wrap the URL; unfold before looking for the token.
    const unfolded = raw.replace(/=\r\n/g, "").replace(/=3D/g, "=");
    expect(unfolded).toContain("token=abc123");
  });
});

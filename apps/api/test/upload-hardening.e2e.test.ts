import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * Upload hardening through the real HTTP surface (P11, D-160): the body is streamed with an early
 * cap, content must match the declared type, and per-interview and per-organization quotas hold.
 */
describeDb("upload hardening", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => "x");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const admin = () => ({ authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" });

  async function setTenant(values: Record<string, unknown>): Promise<void> {
    const res = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: admin(),
      payload: { scope: "tenant", values },
    });
    expect(res.statusCode).toBe(200);
  }

  async function participant(): Promise<string> {
    const staff = { authorization: `Bearer ${world.adminToken}` };
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: { templateId: world.templateId, name: `Hard ${Math.random()}`, verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: staff });
    const opened = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1]}/open`,
      payload: {},
    });
    const token = `Bearer pt.${opened.json<{ participantToken: string }>().participantToken}`;
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: token },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    return token;
  }

  function multipart(
    body: Buffer,
    name = "f.txt",
    type = "text/plain",
  ): { payload: Buffer; headers: Record<string, string> } {
    const boundary = `----hard${Math.random().toString(36).slice(2)}`;
    return {
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
        body,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    };
  }

  async function post(token: string, body: Buffer, name?: string, type?: string) {
    const m = multipart(body, name, type);
    return await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token, ...m.headers },
      payload: m.payload,
    });
  }

  it("rejects an executable renamed .pdf, leaving no row and no object", async () => {
    const token = await participant();
    const before = world.storage.size;
    const rows = await world.db.attachment.count({ where: { companyId: world.companyId } });
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200)]);
    const res = await post(token, exe, "invoice.pdf", "application/pdf");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not really a PDF/i);
    expect(world.storage.size).toBe(before);
    expect(await world.db.attachment.count({ where: { companyId: world.companyId } })).toBe(rows);
  });

  it("rejects a PDF declared as a Word document", async () => {
    const token = await participant();
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const res = await post(
      token,
      pdf,
      "notes.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects UTF-16 text and binary declared as text", async () => {
    const token = await participant();
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\n1,2\n", "utf16le")]);
    expect((await post(token, utf16, "data.csv", "text/csv")).statusCode).toBe(400);
  });

  it("stops at the per-interview attachment count", async () => {
    await setTenant({ "files.maxPerSession": 2 });
    try {
      const token = await participant();
      expect((await post(token, Buffer.from("one"))).statusCode).toBe(200);
      expect((await post(token, Buffer.from("two"))).statusCode).toBe(200);
      const third = await post(token, Buffer.from("three"));
      expect(third.statusCode).toBe(400);
      expect(third.json().error.message).toMatch(/can hold 2 attachments/);
    } finally {
      await setTenant({ "files.maxPerSession": 10 });
    }
  });

  it("stops at the per-interview size quota and caps the stream at what is left", async () => {
    await setTenant({ "files.maxSessionMb": 1 });
    try {
      const token = await participant();
      const almost = Buffer.alloc(800 * 1024, 0x61);
      expect((await post(token, almost)).statusCode).toBe(200);
      // 800 KB used of 1 MB: a second 800 KB file passes the per-file limit but not the quota.
      const second = await post(token, almost);
      expect(second.statusCode).toBe(413);
      expect(second.json().error.message).toMatch(/size limit/);
    } finally {
      await setTenant({ "files.maxSessionMb": 100 });
    }
  });

  it("stops at the organization quota", async () => {
    const used = (
      await world.db.attachment.aggregate({
        where: { companyId: world.companyId },
        _sum: { sizeBytes: true },
      })
    )._sum.sizeBytes;
    expect(used ?? 0).toBeGreaterThan(0);
    await setTenant({ "files.tenantQuotaMb": 1 });
    try {
      const token = await participant();
      const big = Buffer.alloc(1.5 * 1024 * 1024, 0x62);
      const res = await post(token, big);
      expect(res.statusCode).toBe(413);
      expect(res.json().error.message).toMatch(/storage is full|larger than/);
    } finally {
      await setTenant({ "files.tenantQuotaMb": 5120 });
    }
  });

  it("cuts a 150 MB stream off at the cap without buffering it", async () => {
    await setTenant({ "files.maxSizeMb": 20 });
    const token = await participant();
    await world.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = world.app.server.address() as AddressInfo;

    const boundary = "----stream";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.txt"\r\nContent-Type: text/plain\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const total = 150;

    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 10);

    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/v1/p/session/attachments",
          headers: {
            authorization: token,
            "content-type": `multipart/form-data; boundary=${boundary}`,
            "transfer-encoding": "chunked",
            connection: "close",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", (err: NodeJS.ErrnoException) => {
        // The server may close the connection once it has answered; that is the point.
        if (err.code !== "ECONNRESET" && err.code !== "EPIPE") reject(err);
      });
      void (async () => {
        try {
          if (!req.write(head)) await new Promise((r) => req.once("drain", r));
          for (let i = 0; i < total && !req.destroyed; i++) {
            if (!req.write(chunk)) await new Promise((r) => req.once("drain", r));
          }
          req.end(tail);
        } catch {
          /* connection closed by the server */
        }
      })();
    });
    clearInterval(sampler);
    world.app.server.closeAllConnections();

    expect(status).toBe(413);
    expect(peak - baseline).toBeLessThan(50 * 1024 * 1024);
  });
});

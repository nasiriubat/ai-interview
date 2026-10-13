import type { Server } from "node:http";
import { PLATFORM_MAX_UPLOAD_MB } from "@aidp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Upload size is bounded at the API by the tenant's own limit, resolved before the body is read,
 * and no tenant can raise it past the platform ceiling (S6, D-87).
 */
suite("upload limits", () => {
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

  async function participant(): Promise<string> {
    const staff = { authorization: `Bearer ${world.adminToken}` };
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: { templateId: world.templateId, name: `Limits ${Math.random()}`, verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: staff });
    const opened = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1]}/open`,
      payload: {},
    });
    const grant = opened.json<{ participantToken: string }>();
    const token = `Bearer pt.${grant.participantToken}`;
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: token },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    return token;
  }

  function multipart(body: Buffer): { payload: Buffer; headers: Record<string, string> } {
    const boundary = `----limits${Math.random().toString(36).slice(2)}`;
    return {
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        body,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    };
  }

  it("stops a file over the tenant's limit at the limit, and stores nothing", async () => {
    const token = await participant();
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: admin(),
      payload: { scope: "tenant", values: { "files.maxSizeMb": 1 } },
    });
    const before = world.storage.size;
    const body = multipart(Buffer.alloc(8 * 1024 * 1024, 0x61));
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: "too_large" } });
    expect(world.storage.size).toBe(before);
    expect(await world.db.attachment.count({ where: { companyId: world.companyId } })).toBe(0);
  });

  it("accepts a file inside the limit", async () => {
    const token = await participant();
    const body = multipart(Buffer.from("small and fine"));
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/attachments",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not let a tenant set a limit above the platform ceiling", async () => {
    const res = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: admin(),
      payload: { scope: "tenant", values: { "files.maxSizeMb": PLATFORM_MAX_UPLOAD_MB + 1 } },
    });
    expect(res.statusCode).toBe(400);
    const ok = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: admin(),
      payload: { scope: "tenant", values: { "files.maxSizeMb": PLATFORM_MAX_UPLOAD_MB } },
    });
    expect(ok.statusCode).toBe(200);
  });
});

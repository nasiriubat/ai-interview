import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handlers } from "../../worker/src/handlers.js";
import { fakeModelServer, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Tenant suspension (S8, D-86). Staff were already refused at sign-in; this proves the rest:
 * participant tokens already issued, link open, the live-voice socket, background jobs and
 * outgoing email, with staff told why instead of being sent round the sign-in loop.
 */
suite("a suspended tenant", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let port = 0;

  beforeAll(async () => {
    model = await fakeModelServer(
      () => `Hello.\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "role" })}`,
      undefined,
      () => ({ text: "an answer" }),
    );
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" });
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" },
      payload: { scope: "tenant", values: { "features.realtimeVoice": true } },
    });
    await world.app.listen({ port: 0, host: "127.0.0.1" });
    const address = world.app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const admin = () => ({ authorization: `Bearer ${world.adminToken}` });
  const operator = () => ({ authorization: `Bearer ${world.operatorToken}` });
  const setStatus = (status: "active" | "suspended") =>
    world.app.inject({
      method: "PATCH",
      url: `/api/v1/operator/tenants/${world.companyId}`,
      headers: operator(),
      payload: { status },
    });

  async function openSession(): Promise<{ token: string; sessionId: string; linkToken: string }> {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: admin(),
      payload: { templateId: world.templateId, name: `S ${Math.random()}`, verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: admin(),
    });
    const linkToken = link.url.split("/p/")[1]!;
    const grant = (
      await world.app.inject({ method: "POST", url: `/api/v1/p/${linkToken}/open`, payload: {} })
    ).json<{ participantToken: string; sessionId: string }>();
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: `Bearer pt.${grant.participantToken}` },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    return { token: grant.participantToken, sessionId: grant.sessionId, linkToken };
  }

  it("tells staff why with a 403, keeps GET /me answering, and recovers when reactivated", async () => {
    expect(
      (await world.app.inject({ method: "GET", url: "/api/v1/campaigns", headers: admin() })).statusCode,
    ).toBe(200);
    expect((await setStatus("suspended")).statusCode).toBe(200);

    const list = await world.app.inject({ method: "GET", url: "/api/v1/campaigns", headers: admin() });
    expect(list.statusCode).toBe(403);
    expect(list.json()).toMatchObject({ error: { code: "tenant_suspended" } });
    const write = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { ...admin(), "content-type": "application/json" },
      payload: { not: "valid" },
    });
    expect(write.statusCode).toBe(403);

    const me = await world.app.inject({ method: "GET", url: "/api/v1/me", headers: admin() });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ company: { status: string } }>().company.status).toBe("suspended");

    // The operator is not locked out of a tenant they suspended, and can reverse it.
    const asOperator = await world.app.inject({
      method: "GET",
      url: "/api/v1/campaigns",
      headers: { ...operator(), "x-company-id": world.companyId },
    });
    expect(asOperator.statusCode).toBe(200);

    expect((await setStatus("active")).statusCode).toBe(200);
    expect(
      (await world.app.inject({ method: "GET", url: "/api/v1/campaigns", headers: admin() })).statusCode,
    ).toBe(200);
  });

  it("refuses participant tokens and shows an open link as closed, without saying why", async () => {
    const s = await openSession();
    const pt = { authorization: `Bearer pt.${s.token}` };
    expect(
      (await world.app.inject({ method: "GET", url: "/api/v1/p/session", headers: pt })).statusCode,
    ).toBe(200);
    const before = await world.app.inject({ method: "GET", url: `/api/v1/p/${s.linkToken}` });

    expect((await setStatus("suspended")).statusCode).toBe(200);
    try {
      expect(
        (await world.app.inject({ method: "GET", url: "/api/v1/p/session", headers: pt })).statusCode,
      ).toBe(401);
      const turn = await world.app.inject({
        method: "POST",
        url: "/api/v1/p/session/turns",
        headers: pt,
      });
      expect(turn.statusCode).toBe(401);

      // Link open: the same shape as a closed campaign, so a suspension is not detectable.
      const link = await world.app.inject({ method: "GET", url: `/api/v1/p/${s.linkToken}` });
      expect(link.statusCode).toBe(200);
      const body = link.json<{ status: string; campaign: Record<string, unknown> }>();
      expect(body.status).toBe("closed");
      expect(Object.keys(body.campaign).sort()).toEqual(
        Object.keys(before.json<{ campaign: Record<string, unknown> }>().campaign).sort(),
      );
      const open = await world.app.inject({
        method: "POST",
        url: `/api/v1/p/${s.linkToken}/open`,
        payload: {},
      });
      expect(open.statusCode).toBe(409);
    } finally {
      await setStatus("active");
    }
    expect(
      (await world.app.inject({ method: "GET", url: "/api/v1/p/session", headers: pt })).statusCode,
    ).toBe(200);
  });

  it("closes a live-voice socket when the tenant is suspended, at connect and mid-conversation", async () => {
    const { WebSocket } = await import("ws");
    const s = await openSession();

    const open = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/p/session/live`, {
        headers: { authorization: `Bearer pt.${token}` },
      });
      const frames: Record<string, unknown>[] = [];
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (!isBinary) frames.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      });
      const closed = new Promise<number>((resolve) =>
        socket.once("close", (code: number) => {
          resolve(code);
        }),
      );
      await new Promise<void>((resolve) => {
        socket.once("open", () => {
          resolve();
        });
        socket.once("close", () => {
          resolve();
        });
        socket.once("error", () => {
          resolve();
        });
      });
      return { socket, frames, closed };
    };

    // Mid-conversation: connected while active, then the tenant is suspended.
    const live = await open(s.token);
    await new Promise((r) => setTimeout(r, 100));
    expect(live.frames.some((f) => f.type === "ready")).toBe(true);
    expect((await setStatus("suspended")).statusCode).toBe(200);
    try {
      live.socket.send(JSON.stringify({ type: "start" }));
      expect(await live.closed).toBe(1008);

      // At connect: a fresh socket with the same valid token is refused.
      const refused = await open(s.token);
      expect(await refused.closed).toBe(1008);
    } finally {
      await setStatus("active");
    }
  });

  it("skips queued jobs for a suspended tenant and still runs deletion jobs", async () => {
    const s = await openSession();
    const calls: string[] = [];
    const quiet = { info: () => undefined, warn: () => undefined };
    const h = handlers({
      db: world.ctx.db,
      callers: {
        forCompany: async () => {
          calls.push("caller");
          throw new Error("a suspended tenant must not reach a model");
        },
      } as never,
      settings: world.ctx.settings,
      email: world.email,
      jobs: world.jobs,
      crypto: world.crypto,
      storage: world.storage,
      tenants: world.ctx.tenants,
      publicWebUrl: "http://web.test",
      log: quiet,
    });

    expect((await setStatus("suspended")).statusCode).toBe(200);
    try {
      await h["session.extract"]({ sessionId: s.sessionId, companyId: world.companyId });
      await h["session.summarize"]({ sessionId: s.sessionId, companyId: world.companyId });
      expect(calls).toEqual([]);

      // Deletion obligations do not pause with the account.
      await world.db.message.create({ data: { sessionId: s.sessionId, seq: 1, role: "user", content: "x" } });
      await h["privacy.delete-session"]({ sessionId: s.sessionId, companyId: world.companyId });
      expect(await world.db.message.count({ where: { sessionId: s.sessionId } })).toBe(0);
      expect((await world.db.session.findUniqueOrThrow({ where: { id: s.sessionId } })).status).toBe(
        "deleted",
      );
    } finally {
      await setStatus("active");
    }
  });
});

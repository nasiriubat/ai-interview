import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, parseSse, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

suite("participant flow end to end", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const replies = [
    `Hi! Thanks for joining. To start, what is your role?\n${TURN_MARKER}\n${JSON.stringify({
      areaKey: "role",
      widget: {
        type: "single_choice",
        options: [
          { key: "nurse", label: "Nurse" },
          { key: "admin", label: "Administrator", detail: "Office work" },
        ],
      },
      reason: "open role",
    })}`,
    `Got it. What does a typical morning look like?\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "daily", stateDelta: { coverage: { role: { status: "covered", known: "nurse on a ward" } }, profile: { role: "nurse" } } })}`,
  ];
  let i = 0;

  beforeAll(async () => {
    model = await fakeModelServer(() => replies[Math.min(i++, replies.length - 1)]!);
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const staff = (token: string) => ({ authorization: `Bearer ${token}` });

  it("admin creates and opens a campaign; participant verifies by email code, consents, and completes two streamed turns", async () => {
    const { app, adminToken } = world;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff(adminToken),
      payload: { templateId: world.templateId, name: "Ward interviews" },
    });
    expect(created.statusCode).toBe(201);
    const { campaign, link } = created.json<{
      campaign: { id: string; verification: string };
      link: { url: string };
    }>();
    expect(campaign.verification).toBe("email_code");
    const linkToken = link.url.split("/p/")[1]!;
    await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: staff(adminToken),
    });

    const arrival = await app.inject({ method: "GET", url: `/api/v1/p/${linkToken}` });
    expect(arrival.statusCode).toBe(200);
    expect(arrival.json<{ status: string; campaign: { participantFields: unknown[] } }>().status).toBe(
      "open",
    );

    await app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/request`,
      payload: { email: "Eve@Hospital.test" },
    });
    const code = /is (\d{6})/.exec(world.email.sent.at(-1)?.text ?? "")?.[1];
    expect(code).toBeDefined();
    const wrong = await app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/confirm`,
      payload: { email: "eve@hospital.test", code: "000000" },
    });
    expect(wrong.statusCode).toBe(403);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/confirm`,
      payload: { email: "eve@hospital.test", code },
    });
    expect(confirmed.statusCode).toBe(200);
    const { participantToken, sessionId, resume } = confirmed.json<{
      participantToken: string;
      sessionId: string;
      resume: boolean;
    }>();
    expect(resume).toBe(false);
    const pt = { authorization: `Bearer pt.${participantToken}` };

    // A turn before consent is refused; consent then unlocks it.
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/p/session/turns", headers: pt })).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/p/session/consent",
          headers: pt,
          payload: {
            consentVersion: "v1",
            participantFields: { role: "Nurse" },
            participationChoice: "anonymous",
          },
        })
      ).statusCode,
    ).toBe(200);

    // The first turn carries no body; a client that still declares JSON must not be rejected.
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: { ...pt, "content-type": "application/json" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(first.body);
    const text = events
      .filter((e) => e.event === "text")
      .map((e) => (e.data as { delta: string }).delta)
      .join("");
    expect(text.trim()).toBe("Hi! Thanks for joining. To start, what is your role?");
    expect(text).not.toContain(TURN_MARKER);
    const turn = events.find((e) => e.event === "turn")?.data as {
      message: { widget?: { type: string } };
      ended: boolean;
      progress: { areas: { key: string; status: string }[] };
    };
    expect(turn.message.widget?.type).toBe("single_choice");
    expect(turn.ended).toBe(false);
    expect(turn.progress.areas.find((a) => a.key === "role")?.status).toBe("partial");

    // The fake server saw a cache-stable system prompt and the engine focus in the last user message.
    const req = model.requests[0] as { messages: { role: string; content: string }[] };
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages.at(-1)?.content).toContain('open area "role"');

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: pt,
      payload: { content: "", modality: "widget", widgetResponse: { type: "single_choice", key: "nurse" } },
    });
    const turn2 = parseSse(second.body).find((e) => e.event === "turn")?.data as {
      progress: { areas: { key: string; status: string }[] };
    };
    expect(turn2.progress.areas.find((a) => a.key === "role")?.status).toBe("covered");

    const view = await app.inject({ method: "GET", url: "/api/v1/p/session", headers: pt });
    const session = view.json<{
      session: {
        status: string;
        messages: { role: string; content: string; widgetResponse?: unknown }[];
        participant: Record<string, string>;
      };
    }>().session;
    expect(session.status).toBe("active");
    expect(session.messages.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(session.messages[1]?.content).toBe("");
    expect(session.messages[1]?.widgetResponse).toEqual({ type: "single_choice", key: "nurse" });
    expect(session.participant).toEqual({ role: "Nurse" }); // anonymous: no email, no hash exposed

    const calls = await world.db.llmCall.findMany({ where: { sessionId } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.costCents).toBeGreaterThan(0);
    expect(calls[0]?.promptVersion).toMatch(/^interviewer@\d+$/);

    // Same email again resumes the same session: one response per person.
    await app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/request`,
      payload: { email: "eve@hospital.test" },
    });
    const code2 = /is (\d{6})/.exec(world.email.sent.at(-1)?.text ?? "")?.[1];
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/confirm`,
      payload: { email: "EVE@hospital.test", code: code2 },
    });
    const resumed = again.json<{ participantToken: string; sessionId: string; resume: boolean }>();
    expect(resumed).toMatchObject({ sessionId, resume: true });
    // Re-verification rotates the participant token; the old one no longer works.
    expect((await app.inject({ method: "GET", url: "/api/v1/p/session", headers: pt })).statusCode).toBe(401);
    const pt2 = { authorization: `Bearer pt.${resumed.participantToken}` };

    // Staff sees progress and cost, but not the transcript by default for an anonymous participant.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/campaigns/${campaign.id}/sessions`,
      headers: staff(adminToken),
    });
    expect(list.json<{ sessions: { turns: number; costCents: number }[] }>().sessions[0]).toMatchObject({
      turns: 2,
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${sessionId}`,
      headers: staff(adminToken),
    });
    expect(detail.json<{ transcriptVisible: boolean; messages: unknown }>()).toMatchObject({
      transcriptVisible: false,
      messages: null,
    });

    // Delete my data removes messages and marks the session; the follow-up job is queued.
    expect((await app.inject({ method: "DELETE", url: "/api/v1/p/session", headers: pt2 })).statusCode).toBe(
      200,
    );
    expect(await world.db.message.count({ where: { sessionId } })).toBe(0);
    expect((await world.db.session.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("deleted");
    expect(world.jobs.published.some((j) => j.name === "privacy.delete-session")).toBe(true);
  });

  it("refuses a second concurrent turn for the same session and recovers from a stale lock", async () => {
    const { app, adminToken } = world;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff(adminToken),
      payload: { templateId: world.templateId, name: "Lock test", verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: staff(adminToken),
    });
    const opened = await app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1]!}/open`,
      payload: {},
    });
    const { participantToken, sessionId } = opened.json<{ participantToken: string; sessionId: string }>();
    const pt = { authorization: `Bearer pt.${participantToken}` };
    await app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: pt,
      payload: { consentVersion: "v1" },
    });

    await world.db.session.update({ where: { id: sessionId }, data: { turnLockedAt: new Date() } });
    const blocked = await app.inject({ method: "POST", url: "/api/v1/p/session/turns", headers: pt });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: { message: string } }>().error.message).toMatch(/already in progress/);

    await world.db.session.update({
      where: { id: sessionId },
      data: { turnLockedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const allowed = await app.inject({ method: "POST", url: "/api/v1/p/session/turns", headers: pt });
    expect(allowed.statusCode).toBe(200);
    expect((await world.db.session.findUniqueOrThrow({ where: { id: sessionId } })).turnLockedAt).toBeNull();
  });

  it("rejects unauthenticated and cross-tenant staff access and validates bodies", async () => {
    const { app, adminToken, operatorToken } = world;
    expect((await app.inject({ method: "GET", url: "/api/v1/campaigns" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/campaigns",
          headers: { authorization: "Bearer not-a-token" },
        })
      ).statusCode,
    ).toBe(401);
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe("validation");
    // An operator acting on the tenant sees its campaigns; without the header it sees its own (empty) tenant.
    const asTenant = await app.inject({
      method: "GET",
      url: "/api/v1/campaigns",
      headers: { authorization: `Bearer ${operatorToken}`, "x-company-id": world.companyId },
    });
    expect(asTenant.json<{ campaigns: unknown[] }>().campaigns.length).toBeGreaterThan(0);
    const own = await app.inject({
      method: "GET",
      url: "/api/v1/campaigns",
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(own.json<{ campaigns: unknown[] }>().campaigns).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/operator/tenants",
          headers: { authorization: `Bearer ${adminToken}` },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("settings, providers and routes are administrable and audited", async () => {
    const { app, adminToken } = world;
    const h = { authorization: `Bearer ${adminToken}` };
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: h,
      payload: { values: { "campaign.linkExpiryDays": 12, "branding.productName": "Ward Discovery" } },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/v1/settings?scope=tenant", headers: h });
    expect(get.json<{ effective: Record<string, unknown> }>().effective["campaign.linkExpiryDays"]).toBe(12);
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: h,
      payload: { values: { "campaign.linkExpiryDays": 9999 } },
    });
    expect(invalid.statusCode).toBe(400);

    const providers = await app.inject({ method: "GET", url: "/api/v1/providers", headers: h });
    const p = providers.json<{ providers: { id: string; hasKey: boolean; apiKeyEnc?: string }[] }>()
      .providers[0]!;
    expect(p.hasKey).toBe(true);
    expect(p.apiKeyEnc).toBeUndefined();
    const models = await app.inject({ method: "GET", url: `/api/v1/providers/${p.id}/models`, headers: h });
    expect(models.json<{ models: { id: string }[]; importedPrices: number }>()).toMatchObject({
      models: [{ id: "fake-model" }],
      importedPrices: 0,
    }); // admin price wins
    const test = await app.inject({
      method: "POST",
      url: `/api/v1/providers/${p.id}/test`,
      headers: h,
      payload: { model: "fake-model" },
    });
    expect(test.json<{ ok: boolean; costCents: number }>().ok).toBe(true);
    const routes = await app.inject({ method: "GET", url: "/api/v1/routes", headers: h });
    expect(
      routes
        .json<{ routes: { purpose: string; model: string | null; inherited: boolean }[] }>()
        .routes.find((r) => r.purpose === "interview_turn"),
    ).toMatchObject({ model: "fake-model", inherited: false });

    const auditLog = await app.inject({ method: "GET", url: "/api/v1/audit", headers: h });
    const entries = auditLog.json<{ entries: { action: string; actorEmail: string | null }[] }>().entries;
    expect(entries.map((e) => e.action)).toContain("settings.update");
    // The log names who acted, not just an opaque actor id.
    expect(entries.find((e) => e.action === "settings.update")?.actorEmail).toBe(world.adminEmail);
  });
});

import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

/** The resume recap on `GET /p/session` (spec 06, D-172): from state, cached, never a message. */
describeDb("resume recap", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let recapMode: "good" | "bad" = "good";
  const turnReply = `Thanks. What does a typical morning look like?\n${TURN_MARKER}\n${JSON.stringify({
    areaKey: "daily",
    stateDelta: { coverage: { role: { status: "covered", known: "night-shift ward nurse" } } },
  })}`;
  const recapCalls = (): number =>
    model.requests.filter(
      (r) =>
        (r as { response_format?: { json_schema?: { name?: string } } }).response_format?.json_schema
          ?.name === "recap",
    ).length;

  beforeAll(async () => {
    model = await fakeModelServer(
      () => turnReply,
      (name) =>
        name === "recap"
          ? { recap: recapMode === "good" ? "You covered your role. Next we will talk about your day." : "" }
          : {},
    );
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const staff = (): Record<string, string> => ({ authorization: `Bearer ${world.adminToken}` });

  async function participant(name: string): Promise<{ pt: Record<string, string>; sessionId: string }> {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff(),
      payload: { templateId: world.templateId, name, verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: staff(),
    });
    const opened = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1]!}/open`,
      payload: {},
    });
    const { participantToken, sessionId } = opened.json<{ participantToken: string; sessionId: string }>();
    const pt = { authorization: `Bearer pt.${participantToken}` };
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: pt,
      payload: { consentVersion: "v1" },
    });
    return { pt, sessionId };
  }

  const away = (sessionId: string, minutes: number) =>
    world.db
      .$executeRaw`UPDATE "Session" SET "updatedAt" = now() - make_interval(mins => ${minutes}::int) WHERE id = ${sessionId}`;

  const view = async (pt: Record<string, string>) =>
    (await world.app.inject({ method: "GET", url: "/api/v1/p/session", headers: pt })).json<{
      session: { messages: { content: string }[]; recap?: { text: string; source: string } };
    }>().session;

  it("is absent on a new session and on one that was just answered", async () => {
    const { pt } = await participant("Recap: fresh");
    expect((await view(pt)).recap).toBeUndefined();
    await world.app.inject({ method: "POST", url: "/api/v1/p/session/turns", headers: pt });
    expect((await view(pt)).recap).toBeUndefined();
  });

  it("is written from state when the participant has been away, cached, and kept out of the transcript", async () => {
    const { pt, sessionId } = await participant("Recap: away");
    await world.app.inject({ method: "POST", url: "/api/v1/p/session/turns", headers: pt });
    await away(sessionId, 30);

    const first = await view(pt);
    expect(first.recap).toEqual({
      text: "You covered your role. Next we will talk about your day.",
      source: "model",
    });
    expect(first.messages.map((m) => m.content).join(" ")).not.toContain("You covered your role");
    expect(recapCalls()).toBe(1);
    const call = model.requests.find(
      (r) =>
        (r as { response_format?: { json_schema?: { name?: string } } }).response_format?.json_schema
          ?.name === "recap",
    ) as { messages: { content: string }[] };
    expect(JSON.stringify(call.messages)).toContain("night-shift ward nurse");

    // A reload does not call the model again.
    expect((await view(pt)).recap?.text).toBe(first.recap?.text);
    expect(recapCalls()).toBe(1);

    // The ledger names the prompt that wrote it.
    const calls = await world.db.llmCall.findMany({ where: { sessionId, purpose: "resume_summary" } });
    expect(calls.map((c) => c.promptVersion)).toEqual(["recap@1"]);

    // A new turn invalidates the cache; the next absence writes a fresh one.
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: pt,
      payload: { content: "Mostly rounds and charting.", modality: "text" },
    });
    expect((await view(pt)).recap).toBeUndefined();
    await away(sessionId, 30);
    expect((await view(pt)).recap?.source).toBe("model");
    expect(recapCalls()).toBe(2);
  });

  it("falls back to a deterministic sentence when the model's answer is unusable, and caches that too", async () => {
    const { pt, sessionId } = await participant("Recap: fallback");
    await world.app.inject({ method: "POST", url: "/api/v1/p/session/turns", headers: pt });
    await away(sessionId, 30);
    recapMode = "bad";
    try {
      const out = await view(pt);
      expect(out.recap?.source).toBe("fallback");
      expect(out.recap?.text).toMatch(/^Welcome back\. We have already covered Role and responsibilities\./);
      const before = recapCalls();
      await view(pt);
      expect(recapCalls()).toBe(before);
    } finally {
      recapMode = "good";
    }
  });

  it("is shown for a paused session at once, and not at all when the tenant switched it off", async () => {
    const { pt, sessionId } = await participant("Recap: paused");
    await world.app.inject({ method: "POST", url: "/api/v1/p/session/turns", headers: pt });
    await world.app.inject({ method: "POST", url: "/api/v1/p/session/pause", headers: pt });
    expect((await view(pt)).recap).toBeDefined();

    const off = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: staff(),
      payload: { values: { "engine.resumeRecap": false } },
    });
    expect(off.statusCode).toBe(200);
    try {
      await away(sessionId, 60);
      expect((await view(pt)).recap).toBeUndefined();
    } finally {
      await world.app.inject({
        method: "PUT",
        url: "/api/v1/settings?scope=tenant",
        headers: staff(),
        payload: { values: { "engine.resumeRecap": true } },
      });
    }
  });
});

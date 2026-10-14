import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, parseSse, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

/**
 * Participant controls, mode switches, the pinned template version and the deletion confirmation
 * (D-170, D-171, D-175, D-176), through the real HTTP surface and row-level security.
 */
describeDb("participant controls and session bookkeeping", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const reply = (message: string, meta: object): string =>
    `${message}\n${TURN_MARKER}\n${JSON.stringify(meta)}`;

  beforeAll(async () => {
    model = await fakeModelServer(() => reply("Tell me more about your day.", { areaKey: "daily" }));
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const asStaff = (): Record<string, string> => ({ authorization: `Bearer ${world.adminToken}` });

  /** An open-link campaign and one consented participant on it. */
  async function participant(
    name: string,
    over: { verification?: string; participationMode?: string } = {},
  ): Promise<{ pt: Record<string, string>; sessionId: string; campaignId: string; linkToken: string }> {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: asStaff(),
      payload: { templateId: world.templateId, name, verification: "open", ...over },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: asStaff(),
    });
    const linkToken = link.url.split("/p/")[1]!;
    const opened = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/open`,
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
    return { pt, sessionId, campaignId: campaign.id, linkToken };
  }

  const turn = (pt: Record<string, string>, payload?: object) =>
    world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: pt,
      ...(payload ? { payload } : {}),
    });

  it("skips an area as a state operation: a control event, no user message, one control session event", async () => {
    const { pt, sessionId } = await participant("Skip test");
    expect((await turn(pt)).statusCode).toBe(200);

    const skipped = await turn(pt, { control: { type: "skip_area", areaKey: "role" } });
    expect(skipped.statusCode).toBe(200);
    const events = parseSse(skipped.body);
    const names = events.map((e) => e.event);
    expect(names.indexOf("control")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("control")).toBeLessThan(names.indexOf("turn"));
    const control = events.find((e) => e.event === "control")?.data as {
      kind: string;
      areaKey: string;
      progress: { areas: { key: string; status: string }[] };
    };
    expect(control).toMatchObject({ kind: "skip_area", areaKey: "role" });
    expect(control.progress.areas.find((a) => a.key === "role")?.status).toBe("skipped");

    const messages = await world.db.message.findMany({ where: { sessionId }, orderBy: { seq: "asc" } });
    expect(messages.map((m) => m.role)).toEqual(["assistant", "assistant"]);
    expect(messages.map((m) => m.content).join(" ")).not.toMatch(/skip/i);
    const logged = await world.db.sessionEvent.findMany({ where: { sessionId, type: "control" } });
    expect(logged).toHaveLength(1);
    expect(logged[0]?.payload).toMatchObject({ kind: "skip_area", areaKey: "role" });

    // The model was told, from state, in one line; it was never shown a participant utterance.
    const last = (model.requests.at(-1) as { messages: { content: string }[] }).messages.at(-1)!;
    expect(last.content).toContain("chose to skip");
  });

  it("comes back to a skipped area", async () => {
    const { pt, sessionId } = await participant("Return test");
    await turn(pt);
    await turn(pt, { control: { type: "skip_area", areaKey: "role" } });
    const back = await turn(pt, { control: { type: "return_area", areaKey: "role" } });
    const control = parseSse(back.body).find((e) => e.event === "control")?.data as {
      progress: { areas: { key: string; status: string }[] };
    };
    expect(control.progress.areas.find((a) => a.key === "role")?.status).toBe("partial");
    const state = (await world.db.session.findUniqueOrThrow({ where: { id: sessionId } })).state as {
      requestedAreaKey?: string;
    };
    expect(state.requestedAreaKey).toBeUndefined(); // consumed by the turn that asked it
    expect(await world.db.message.count({ where: { sessionId, role: "user" } })).toBe(0);
  });

  it("finish closes on the flag and leaves the turn count alone", async () => {
    const { pt, sessionId } = await participant("Finish test");
    await turn(pt);
    const done = await turn(pt, { control: { type: "finish" } });
    expect(parseSse(done.body).some((e) => e.event === "control")).toBe(true);
    const state = (await world.db.session.findUniqueOrThrow({ where: { id: sessionId } })).state as {
      finishRequested: boolean;
      closingAsked: boolean;
      turnCount: number;
    };
    expect(state).toMatchObject({ finishRequested: true, closingAsked: true, turnCount: 2 });
    expect(await world.db.message.count({ where: { sessionId, role: "user" } })).toBe(0);
  });

  it("refuses an unknown area, and a control combined with an answer, and keeps the session usable", async () => {
    const { pt } = await participant("Refusal test");
    await turn(pt);
    const unknown = await turn(pt, { control: { type: "skip_area", areaKey: "no-such-area" } });
    expect(unknown.statusCode).toBe(400);
    const mixed = await turn(pt, { content: "hello", control: { type: "finish" } });
    expect(mixed.statusCode).toBe(400);
    // The lock was released: the next turn runs.
    expect((await turn(pt, { content: "I am a nurse", modality: "text" })).statusCode).toBe(200);
  });

  it("keeps the legacy complete endpoint working, deprecated, on the same flag", async () => {
    const { pt, sessionId } = await participant("Legacy complete");
    await turn(pt);
    const res = await world.app.inject({ method: "POST", url: "/api/v1/p/session/complete", headers: pt });
    expect(res.statusCode).toBe(200);
    expect(res.headers.deprecation).toBe("true");
    const state = (await world.db.session.findUniqueOrThrow({ where: { id: sessionId } })).state as {
      finishRequested: boolean;
      turnCount: number;
    };
    expect(state.finishRequested).toBe(true);
    expect(state.turnCount).toBe(1);
    const next = parseSse((await turn(pt)).body).find((e) => e.event === "turn");
    expect(next).toBeDefined();
  });

  it("records a mode_switch event when the answer mode changes, and only then", async () => {
    const { pt, sessionId } = await participant("Mode test");
    const set = (mode: string, reason?: string) =>
      world.app.inject({
        method: "POST",
        url: "/api/v1/p/session/mode",
        headers: pt,
        payload: { mode, ...(reason ? { reason } : {}) },
      });
    expect((await set("voice")).statusCode).toBe(200);
    await set("voice");
    expect((await set("chat", "fallback_typing")).statusCode).toBe(200);
    expect((await set("chat", "nonsense")).statusCode).toBe(400);

    const events = await world.db.sessionEvent.findMany({
      where: { sessionId, type: "mode_switch" },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => e.payload)).toEqual([
      { from: "chat", to: "voice", reason: "participant" },
      { from: "voice", to: "chat", reason: "fallback_typing" },
    ]);
  });

  it("pins the session to the campaign template's version", async () => {
    const template = await world.db.interviewTemplate.findUniqueOrThrow({ where: { id: world.templateId } });
    const v3 = await world.db.interviewTemplate.create({
      data: {
        companyId: template.companyId,
        key: template.key,
        version: template.version + 2,
        status: "published",
        name: template.name,
        objective: template.objective,
        privacyMode: template.privacyMode,
        language: template.language,
        coverageAreas: template.coverageAreas ?? [],
      },
    });
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: asStaff(),
      payload: { templateId: v3.id, name: "Pinned", verification: "open" },
    });
    expect(created.body).toContain("campaign");
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: asStaff(),
    });
    const opened = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1]!}/open`,
      payload: {},
    });
    const { sessionId } = opened.json<{ sessionId: string }>();
    const row = await world.db.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.templateVersion).toBe(template.version + 2);
    expect(row.templateVersion).not.toBe(1);
  });

  it("confirms a deletion by email to an identified participant, with the address encrypted in the job", async () => {
    const { app } = world;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: asStaff(),
      payload: {
        templateId: world.templateId,
        name: "Identified",
        verification: "email_code",
        participationMode: "identified",
      },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: asStaff() });
    const linkToken = link.url.split("/p/")[1]!;
    await app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/request`,
      payload: { email: "Ida@Clinic.test" },
    });
    const code = /is (\d{6})/.exec(world.email.sent.at(-1)?.text ?? "")?.[1];
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/confirm`,
      payload: { email: "ida@clinic.test", code },
    });
    const { participantToken, sessionId } = confirmed.json<{ participantToken: string; sessionId: string }>();
    const pt = { authorization: `Bearer pt.${participantToken}` };
    await app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: pt,
      payload: { consentVersion: "v1", participationChoice: "identified" },
    });

    const before = world.jobs.published.length;
    const del = await app.inject({ method: "DELETE", url: "/api/v1/p/session", headers: pt });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true, emailSent: true });

    const published = world.jobs.published.slice(before);
    const notice = published.find((j) => j.name === "privacy.confirm-deletion");
    expect(notice).toBeDefined();
    const payload = notice?.payload as { toEnc: string; sessionId: string; campaignName: string };
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.campaignName).toBe("Identified");
    // Only the ciphertext is queued; the address can be recovered with the key and nowhere else.
    expect(JSON.stringify(payload)).not.toMatch(/ida@clinic\.test/i);
    expect(world.crypto.decrypt(payload.toEnc)).toBe("ida@clinic.test");
    // The erase finished before the notice was queued, and nothing was kept.
    expect((await world.db.session.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("deleted");
    expect(await world.db.participant.count({ where: { campaignId: campaign.id } })).toBe(0);
  });

  it("sends no confirmation to an anonymous participant", async () => {
    const { pt } = await participant("Anonymous delete", { participationMode: "anonymous" });
    const before = world.jobs.published.length;
    const del = await world.app.inject({ method: "DELETE", url: "/api/v1/p/session", headers: pt });
    expect(del.json()).toEqual({ ok: true, emailSent: false });
    expect(world.jobs.published.slice(before).some((j) => j.name === "privacy.confirm-deletion")).toBe(false);
  });
});

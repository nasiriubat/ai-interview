import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

/**
 * The end-of-interview summary (D-325). `GET /p/session/summary` answers with the written summary
 * (what the participant saved, else the interviewer's closing summary turn), says when it is still
 * being written, and says when none is coming. It never answers with the last reply of the
 * transcript: in the demo run that reply was typed into the empty box and read as the summary.
 */
describeDb("participant end-of-interview summary", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };

  beforeAll(async () => {
    model = await fakeModelServer(() => `Thanks.\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "daily" })}`);
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" });
    await world.db.interviewTemplate.update({
      where: { id: world.templateId },
      data: { endSummary: true },
    });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const staff = () => ({ authorization: `Bearer ${world.adminToken}` });

  async function session(): Promise<{ id: string; pt: { authorization: string } }> {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff(),
      payload: { templateId: world.templateId, name: `Summary ${Date.now()}`, verification: "open" },
    });
    const { campaign, link } = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaign.id}/open`,
      headers: staff(),
    });
    const token = link.url.split("/p/")[1]!;
    const opened = await world.app.inject({ method: "POST", url: `/api/v1/p/${token}/open`, payload: {} });
    const grant = opened.json<{ participantToken: string; sessionId: string }>();
    return { id: grant.sessionId, pt: { authorization: `Bearer pt.${grant.participantToken}` } };
  }

  const get = async (pt: { authorization: string }) =>
    (await world.app.inject({ method: "GET", url: "/api/v1/p/session/summary", headers: pt })).json<{
      summary: string;
      status: string;
    }>();

  let seq = 0;
  const say = async (sessionId: string, role: "assistant" | "user", content: string, areaKey?: string) => {
    seq += 1;
    await world.db.message.create({
      data: {
        companyId: world.companyId,
        sessionId,
        seq,
        role,
        content,
        ...(areaKey ? { areaKey } : {}),
      },
    });
  };

  it("is unavailable, not the last reply, while the interview is still going", async () => {
    const s = await session();
    seq = 0;
    await say(s.id, "assistant", "What does a morning look like?", "daily");
    await say(s.id, "user", "Busy.");
    const out = await get(s.pt);
    expect(out).toMatchObject({ summary: "", status: "unavailable" });
  });

  it("is pending when the interview has just ended and the summary turn is not stored yet", async () => {
    const s = await session();
    seq = 0;
    await say(s.id, "assistant", "Anything else I should have asked?", "closing");
    await say(s.id, "user", "No, that is everything.");
    await world.db.session.update({
      where: { id: s.id },
      data: { status: "completed", endedAt: new Date(), state: { phase: "done", facts: [] } },
    });
    expect(await get(s.pt)).toMatchObject({ summary: "", status: "pending" });
  });

  it("is unavailable once it is clear none is coming", async () => {
    const s = await session();
    seq = 0;
    await say(s.id, "assistant", "Thanks, that is all.", "closing");
    await world.db.session.update({
      where: { id: s.id },
      data: {
        status: "completed",
        endedAt: new Date(Date.now() - 60 * 60_000),
        state: { phase: "done", facts: [] },
      },
    });
    expect(await get(s.pt)).toMatchObject({ summary: "", status: "unavailable" });
  });

  it("is the interviewer's summary turn, whatever was said after it, and then the participant's edit", async () => {
    const s = await session();
    seq = 0;
    await say(s.id, "assistant", "Here is what I took: notes are typed twice.", "summary");
    await say(s.id, "user", "No, that's accurate. You have captured the rhythm of the day.");
    await say(s.id, "assistant", "Thank you, take care.", "closing");
    await world.db.session.update({
      where: { id: s.id },
      data: { status: "completed", endedAt: new Date(), state: { phase: "done", facts: [] } },
    });
    expect(await get(s.pt)).toEqual({
      summary: "Here is what I took: notes are typed twice.",
      facts: [],
      status: "ready",
    });

    const put = await world.app.inject({
      method: "PUT",
      url: "/api/v1/p/session/summary",
      headers: s.pt,
      payload: { summary: "Notes are typed twice, and only on night shifts." },
    });
    expect(put.statusCode).toBe(200);
    expect(await get(s.pt)).toMatchObject({
      summary: "Notes are typed twice, and only on night shifts.",
      status: "ready",
    });
  });
});

import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

/**
 * A flag raised by the engine reaches the people who can act on it (blueprint feature 10, D-173):
 * the session row, the campaign's list and its filter, the detail (reason only behind the
 * transcript rule), an acknowledge with an audit row, and one tenant alert with ids only.
 */
describeDb("flagged interviews", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  const REASON = "the participant said they feel hopeless and may harm themselves";
  let flagNext = true;

  beforeAll(async () => {
    model = await fakeModelServer(
      () =>
        `I am sorry you are going through that.\n${TURN_MARKER}\n${JSON.stringify({
          areaKey: "role",
          stateDelta: flagNext ? { flagForAdmin: REASON } : {},
        })}`,
    );
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const staff = (): Record<string, string> => ({ authorization: `Bearer ${world.adminToken}` });

  async function participant(
    name: string,
  ): Promise<{ pt: Record<string, string>; sessionId: string; campaignId: string }> {
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
    return { pt, sessionId, campaignId: campaign.id };
  }

  const turn = (pt: Record<string, string>, payload?: object) =>
    world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: pt,
      ...(payload ? { payload } : {}),
    });

  const list = async (campaignId: string, query = "") =>
    (
      await world.app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${campaignId}/sessions${query}`,
        headers: staff(),
      })
    ).json<{ sessions: { id: string; flagged: boolean; flagAckedAt: string | null }[]; total: number }>();

  it("marks the session, lists it, filters on it, and raises one tenant alert without the reason", async () => {
    const { pt, sessionId, campaignId } = await participant("Flagged");
    const other = await participant("Not flagged here");
    flagNext = false;
    await turn(other.pt);
    flagNext = true;

    await turn(pt);
    await turn(pt, { content: "I do not see the point any more", modality: "text" });

    const row = await world.db.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row).toMatchObject({ flagged: true, flagReason: REASON, flagAckedAt: null });
    expect(row.flaggedAt).not.toBeNull();
    // Each flagging turn appends its event; the row keeps the first.
    expect(await world.db.sessionEvent.count({ where: { sessionId, type: "flag" } })).toBe(2);

    const all = await list(campaignId);
    expect(all.sessions.find((s) => s.id === sessionId)).toMatchObject({ flagged: true, flagAckedAt: null });
    expect((await list(campaignId, "?flagged=true")).sessions.map((s) => s.id)).toEqual([sessionId]);
    expect((await list(campaignId, "?flagged=false")).total).toBe(0);
    expect((await list(other.campaignId, "?flagged=true")).total).toBe(0);
    expect((await list(other.campaignId, "?flagged=false")).total).toBe(1);

    // Exactly one notice for the interview, to the tenant, with ids and no prose about the person.
    const alerts = world.alerts.ofKind("session.flagged").filter((a) => a.context?.sessionId === sessionId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ companyId: world.companyId });
    expect(JSON.stringify(alerts[0])).not.toContain("hopeless");
  });

  it("shows the reason only to someone who may read the transcript", async () => {
    const { pt, sessionId } = await participant("Reason visibility");
    await turn(pt);
    const get = async () =>
      (
        await world.app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}`, headers: staff() })
      ).json<{ session: { flagged: boolean; flagReason: string | null; state: Record<string, unknown> } }>()
        .session;

    const hidden = await get();
    expect(hidden).toMatchObject({ flagged: true, flagReason: null });
    expect(JSON.stringify(hidden)).not.toContain("hopeless");

    const put = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings?scope=tenant",
      headers: staff(),
      payload: { values: { "privacy.rawTranscriptsVisibleTo": "admins" } },
    });
    expect(put.statusCode).toBe(200);
    try {
      expect(await get()).toMatchObject({ flagged: true, flagReason: REASON });
    } finally {
      await world.app.inject({
        method: "PUT",
        url: "/api/v1/settings?scope=tenant",
        headers: staff(),
        payload: { values: { "privacy.rawTranscriptsVisibleTo": "admins_when_identified_and_opted_in" } },
      });
    }
  });

  it("acknowledges once, writes an audit row, and refuses to acknowledge what is not flagged", async () => {
    const { pt, sessionId, campaignId } = await participant("Ack");
    await turn(pt);

    const first = await world.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/flag/ack`,
      headers: staff(),
      payload: { note: "Spoke to the team lead" },
    });
    expect(first.statusCode).toBe(200);
    const at = first.json<{ flagAckedAt: string }>().flagAckedAt;
    const again = await world.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/flag/ack`,
      headers: staff(),
      payload: {},
    });
    expect(again.json<{ flagAckedAt: string }>().flagAckedAt).toBe(at);

    const row = await world.db.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.flagAckedAt?.toISOString()).toBe(at);
    expect(row.flagAckedBy).not.toBeNull();
    const audit = await world.db.auditLog.findMany({
      where: { companyId: world.companyId, action: "session.flag.ack", targetId: sessionId },
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit.map((a) => a.diff))).not.toContain("hopeless");
    expect((await list(campaignId)).sessions[0]?.flagAckedAt).toBe(at);

    flagNext = false;
    const clean = await participant("Clean");
    await turn(clean.pt);
    flagNext = true;
    const refused = await world.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${clean.sessionId}/flag/ack`,
      headers: staff(),
      payload: {},
    });
    expect(refused.statusCode).toBe(409);
  });

  it("does not let another tenant's admin acknowledge it", async () => {
    const { pt, sessionId } = await participant("Cross tenant");
    await turn(pt);
    const res = await world.app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/flag/ack`,
      headers: { authorization: `Bearer ${world.operatorToken}` },
      payload: {},
    });
    // The operator's own tenant owns no such session.
    expect(res.statusCode).toBe(404);
  });
});

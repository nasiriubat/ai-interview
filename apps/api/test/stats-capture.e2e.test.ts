import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * The two things the dashboard cannot derive afterwards and so records when they happen
 * (migration 0021): that a reminder was sent, and whether the person gave their identity.
 */
describeDb("statistics capture", () => {
  let world: TestWorld;
  let model: { server: Server; url: string };
  let n = 0;
  const admin = () => ({ authorization: `Bearer ${world.adminToken}` });

  beforeAll(async () => {
    model = await fakeModelServer(() => "unused");
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  async function open(
    participationMode: string,
    verification = "open",
  ): Promise<{ id: string; link: string }> {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: admin(),
      payload: { templateId: world.templateId, name: `Capture ${++n}`, participationMode, verification },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${body.campaign.id}/open`,
      headers: admin(),
    });
    return { id: body.campaign.id, link: body.link.url.split("/p/")[1]! };
  }

  async function consent(link: string, choice?: "identified" | "anonymous"): Promise<string> {
    const opened = await world.app.inject({ method: "POST", url: `/api/v1/p/${link}/open`, payload: {} });
    const { participantToken, sessionId } = opened.json<{ participantToken: string; sessionId: string }>();
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: `Bearer pt.${participantToken}` },
      payload: { consentVersion: "v1", ...(choice ? { participationChoice: choice } : {}) },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return sessionId;
  }

  it("marks a session identified only when the person gave their identity", async () => {
    const identified = await open("identified");
    const anonymous = await open("anonymous");
    const choice = await open("participant_choice");
    const flag = async (id: string): Promise<boolean> =>
      (await world.db.session.findUniqueOrThrow({ where: { id } })).identified;
    expect(await flag(await consent(identified.link))).toBe(true);
    expect(await flag(await consent(anonymous.link))).toBe(false);
    expect(await flag(await consent(choice.link, "identified"))).toBe(true);
    expect(await flag(await consent(choice.link, "anonymous"))).toBe(false);
  });

  it("counts each reminder on the invitation, with when the last went out", async () => {
    const c = await open("identified", "invitation");
    const invited = await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${c.id}/invitations`,
      headers: admin(),
      payload: { emails: [`remind-${Date.now()}@ward.test`] },
    });
    expect(invited.statusCode).toBe(200);
    const inv = await world.db.invitation.findFirstOrThrow({ where: { campaignId: c.id } });
    expect(inv.reminderCount).toBe(0);
    for (let i = 0; i < 2; i++) {
      const r = await world.app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${c.id}/invitations/${inv.id}/remind`,
        headers: admin(),
      });
      expect(r.statusCode, r.body).toBeLessThan(300);
    }
    const after = await world.db.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.reminderCount).toBe(2);
    expect(after.lastRemindedAt).not.toBeNull();
    const p = await world.app.inject({
      method: "GET",
      url: `/api/v1/stats/participation?campaignId=${c.id}`,
      headers: admin(),
    });
    expect(p.json<{ reminders: { sent: number } }>().reminders).toEqual({ sent: 2, invitationsReminded: 1 });
  });
});

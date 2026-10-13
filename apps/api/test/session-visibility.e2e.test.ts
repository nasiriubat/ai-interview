import type { Server } from "node:http";
import { encode } from "@auth/core/jwt";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, TEST_AUTH_SECRET, testWorld, type TestWorld } from "./helpers.js";

/**
 * Who may read a transcript, and what a staff session or campaign response may contain (D-144).
 * `privacy.rawTranscriptsVisibleTo` names administrators; before this a member passed the `admins`
 * branch, and the responses spread database rows that held a link hash, invitee addresses and the
 * participant's fields.
 */
describeDb("transcript visibility by role and explicit staff DTOs", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let memberToken = "";
  let memberId = "";
  let campaignId = "";
  let linkToken = "";
  let identifiedSession = "";
  let optedInSession = "";
  let anonymousSession = "";
  let ownedSession = "";

  const admin = () => ({ authorization: `Bearer ${world.adminToken}` });
  const member = () => ({ authorization: `Bearer ${memberToken}` });
  // The operator belongs to the platform's own company; it reaches a tenant's session by naming it.
  const operator = () => ({
    authorization: `Bearer ${world.operatorToken}`,
    "x-company-id": world.companyId,
  });
  const setVisibility = async (value: string) => {
    const res = await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: admin(),
      payload: { values: { "privacy.rawTranscriptsVisibleTo": value } },
    });
    expect(res.statusCode).toBe(200);
  };
  type SessionBody = {
    session: Record<string, unknown> & { messages: unknown[] | null; summary: string };
    messages: { content: string }[] | null;
    transcriptVisible: boolean;
  };
  const read = async (headers: Record<string, string>, id: string) => {
    const res = await world.app.inject({ method: "GET", url: `/api/v1/sessions/${id}`, headers });
    expect(res.statusCode).toBe(200);
    return res.json<SessionBody>();
  };

  async function makeSession(opts: {
    participationMode: string;
    fields?: Record<string, string>;
    ownerUserId?: string;
    sourceKind?: string;
    campaign?: boolean;
  }): Promise<string> {
    const useCampaign = opts.campaign ?? true;
    const campaign = useCampaign
      ? await world.db.campaign.create({
          data: {
            companyId: world.companyId,
            templateId: world.templateId,
            name: `Visibility ${opts.participationMode}`,
            participationMode: opts.participationMode,
            linkTokenHash: `vis-${Math.random()}`,
            createdById: (await world.db.user.findFirstOrThrow({ where: { companyId: world.companyId } })).id,
          },
        })
      : null;
    const participant = await world.db.participant.create({
      data: {
        companyId: world.companyId,
        ...(campaign ? { campaignId: campaign.id } : {}),
        fields: opts.fields ?? {},
        tokenHash: `vis-${Math.random()}`,
      },
    });
    const session = await world.db.session.create({
      data: {
        companyId: world.companyId,
        templateId: world.templateId,
        ...(campaign ? { campaignId: campaign.id } : {}),
        participantId: participant.id,
        ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
        sourceKind: opts.sourceKind ?? "campaign",
        status: "completed",
        consentedAt: new Date("2026-03-04T10:11:12Z"),
        summary: "the participant described moving numbers between two systems",
        startedAt: new Date("2026-03-04T10:11:12Z"),
        endedAt: new Date("2026-03-04T10:41:12Z"),
        handoff: { problem: "secret problem", tools: ["Secret tool"] },
        invitations: [{ id: "i1", email: "invitee@secret.example", status: "sent", tokenHash: "x" }],
        state: { coverage: { role: { status: "covered" } }, facts: [{ quote: "private words" }] },
      },
    });
    await world.db.message.create({
      data: {
        companyId: world.companyId,
        sessionId: session.id,
        seq: 1,
        role: "user",
        content: "I move the numbers by hand",
      },
    });
    return session.id;
  }

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url);
    const email = `member-${Date.now()}@test.io`;
    memberId = (await world.db.user.create({ data: { companyId: world.companyId, email, role: "member" } }))
      .id;
    memberToken = await encode({
      token: { email },
      secret: TEST_AUTH_SECRET,
      salt: "authjs.session-token",
    });

    identifiedSession = await makeSession({ participationMode: "identified", fields: { name: "Eve" } });
    optedInSession = await makeSession({
      participationMode: "identified",
      fields: { name: "Eve", transcriptOptIn: "true" },
    });
    anonymousSession = await makeSession({ participationMode: "anonymous" });
    ownedSession = await makeSession({
      participationMode: "identified",
      campaign: false,
      ownerUserId: memberId,
      sourceKind: "text",
    });
    // The campaign API tests need a real campaign with a link.
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: admin(),
      payload: { templateId: world.templateId, name: "Visible campaign", verification: "invitation" },
    });
    const body = created.json<{ campaign: { id: string }; link: { url: string } }>();
    campaignId = body.campaign.id;
    linkToken = body.link.url.split("/p/")[1]!;
  });
  afterAll(async () => {
    await setVisibility("admins_when_identified_and_opted_in");
    await world.close();
    model.server.close();
  });

  describe("raw transcripts", () => {
    it("are shown to nobody when the setting says nobody, administrators included", async () => {
      await setVisibility("nobody");

      for (const who of [admin(), member(), operator()]) {
        const body = await read(who, identifiedSession);
        expect(body.transcriptVisible).toBe(false);
        expect(body.messages).toBeNull();
      }
    });

    it("are shown to administrators and not to members when the setting says admins", async () => {
      await setVisibility("admins");

      const asAdmin = await read(admin(), anonymousSession);
      const asOperator = await read(operator(), anonymousSession);
      const asMember = await read(member(), anonymousSession);

      expect(asAdmin.transcriptVisible).toBe(true);
      expect(asAdmin.messages?.map((m) => m.content)).toEqual(["I move the numbers by hand"]);
      expect(asOperator.transcriptVisible).toBe(true);
      expect(asMember.transcriptVisible).toBe(false);
      expect(asMember.messages).toBeNull();
      expect(JSON.stringify(asMember)).not.toContain("by hand");
    });

    it("are shown only for an identified, opted-in participant under the default setting, and only to administrators", async () => {
      await setVisibility("admins_when_identified_and_opted_in");

      expect((await read(admin(), optedInSession)).transcriptVisible).toBe(true);
      expect((await read(admin(), identifiedSession)).transcriptVisible).toBe(false);
      expect((await read(admin(), anonymousSession)).transcriptVisible).toBe(false);
      expect((await read(member(), optedInSession)).transcriptVisible).toBe(false);
    });

    it("leave the summary, which is the transcript condensed, out when the transcript is hidden", async () => {
      await setVisibility("admins");

      expect((await read(member(), identifiedSession)).session.summary).toBe("");
      expect((await read(admin(), identifiedSession)).session.summary).toContain("moving numbers");
    });

    it("are refused to a member on the events route under every setting", async () => {
      for (const value of ["nobody", "admins", "admins_when_identified_and_opted_in"]) {
        await setVisibility(value);
        const res = await world.app.inject({
          method: "GET",
          url: `/api/v1/sessions/${identifiedSession}/events`,
          headers: member(),
        });
        expect(res.statusCode).toBe(403);
      }
    });

    it("stay readable by the member who owns the requirements session, unless the setting is nobody", async () => {
      await setVisibility("admins_when_identified_and_opted_in");
      expect((await read(member(), ownedSession)).transcriptVisible).toBe(true);
      await setVisibility("nobody");
      expect((await read(member(), ownedSession)).transcriptVisible).toBe(false);
    });
  });

  describe("the session response", () => {
    it("is an explicit view: no link hash, hand-off, invitee address, participant or other columns", async () => {
      await setVisibility("admins");

      const body = await read(admin(), identifiedSession);

      const text = JSON.stringify(body);
      for (const forbidden of [
        "linkTokenHash",
        "handoff",
        "secret problem",
        "invitations",
        "invitee@secret.example",
        "specEdits",
        "participantId",
        "ownerUserId",
        "turnLockedAt",
        "companyId",
      ])
        expect(text).not.toContain(forbidden);
      expect(Object.keys(body.session).sort()).toEqual(
        [
          "campaign",
          "campaignId",
          "consentVersion",
          "consentedAt",
          "createdAt",
          "endedAt",
          "id",
          "messages",
          "modePreference",
          "path",
          "sourceKind",
          "startedAt",
          "state",
          "status",
          "summary",
          "templateId",
          "templateKey",
          "templateVersion",
          "transcriptVisible",
          "updatedAt",
        ].sort(),
      );
      expect(body.session.campaign).toMatchObject({ participationMode: "identified" });
    });

    it("carries only coverage in the state when the transcript is hidden", async () => {
      await setVisibility("nobody");

      const body = await read(admin(), identifiedSession);

      expect(body.session.state).toEqual({ coverage: { role: { status: "covered" } } });
      expect(JSON.stringify(body)).not.toContain("private words");
    });

    it("gives an anonymous participant's session times as days, and an identified one's exactly", async () => {
      await setVisibility("admins");

      const anonymous = await read(admin(), anonymousSession);
      const identified = await read(admin(), identifiedSession);

      expect(anonymous.session.startedAt).toBe("2026-03-04T00:00:00.000Z");
      expect(anonymous.session.endedAt).toBe("2026-03-04T00:00:00.000Z");
      expect(identified.session.startedAt).toBe("2026-03-04T10:11:12.000Z");
    });
  });

  describe("the campaign responses", () => {
    it("never carry the link hash, on any route and for any role", async () => {
      const responses = [
        await world.app.inject({ method: "GET", url: "/api/v1/campaigns", headers: admin() }),
        await world.app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}`, headers: admin() }),
        await world.app.inject({ method: "GET", url: `/api/v1/campaigns/${campaignId}`, headers: member() }),
        await world.app.inject({
          method: "PATCH",
          url: `/api/v1/campaigns/${campaignId}`,
          headers: admin(),
          payload: { name: "Visible campaign" },
        }),
        await world.app.inject({
          method: "POST",
          url: `/api/v1/campaigns/${campaignId}/open`,
          headers: admin(),
        }),
      ];

      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain("linkTokenHash");
        expect(res.body).not.toContain("companyId");
      }
    });

    it("show the share link to administrators and not to members", async () => {
      const asAdmin = await world.app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${campaignId}`,
        headers: admin(),
      });
      const asMember = await world.app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${campaignId}`,
        headers: member(),
      });

      expect(asAdmin.json<{ link: { url: string } }>().link.url).toContain(`/p/${linkToken}`);
      expect(asMember.statusCode).toBe(200);
      expect(asMember.body).not.toContain(linkToken);
      expect(asMember.json<{ link?: unknown }>().link).toBeUndefined();
    });

    it("show invitee addresses to administrators and withhold them from members", async () => {
      const invited = await world.app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${campaignId}/invitations`,
        headers: admin(),
        payload: { emails: ["invitee@ward.example"] },
      });
      expect(invited.statusCode).toBe(200);

      const asAdmin = await world.app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${campaignId}/invitations`,
        headers: admin(),
      });
      const asMember = await world.app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${campaignId}/invitations`,
        headers: member(),
      });

      expect(asAdmin.json<{ invitations: { email: string | null }[] }>().invitations[0]?.email).toBe(
        "invitee@ward.example",
      );
      expect(asMember.statusCode).toBe(200);
      expect(
        asMember.json<{ invitations: { email: string | null; status: string }[] }>().invitations[0],
      ).toMatchObject({
        email: null,
        status: "sent",
      });
      expect(asMember.body).not.toContain("invitee@ward.example");
    });
  });
});

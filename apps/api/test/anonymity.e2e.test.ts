import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

/**
 * The anonymous participation promise (spec 06, 11; D-142): the same address is a different hash in
 * every campaign, an anonymous response is reachable from no stored value but the one the returning
 * person supplies, and the timestamps that would pair an invitation with a session are a day wide.
 */
describeDb("anonymous campaigns: salt, no stored link, coarse time", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let n = 0;

  const admin = () => ({ authorization: `Bearer ${world.adminToken}` });
  const startOfDay = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).getTime();

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url, { RATE_LIMIT_MAX: "100000", RATE_LIMIT_EXPENSIVE_MAX: "100000" });
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  async function campaign(
    participationMode: "anonymous" | "identified" | "participant_choice",
    verification: "email_code" | "invitation" = "email_code",
  ): Promise<{ id: string; linkToken: string }> {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: admin(),
      payload: {
        templateId: world.templateId,
        name: `Campaign ${++n}`,
        participationMode,
        verification,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ campaign: { id: string }; link: { url: string } }>();
    await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${body.campaign.id}/open`,
      headers: admin(),
    });
    return { id: body.campaign.id, linkToken: body.link.url.split("/p/")[1]! };
  }

  // A client address per call: the code endpoints are capped per address, and this suite is not
  // about the cap (code-caps.e2e.test.ts is).
  let hop = 0;
  const fresh = () => ({ "x-forwarded-for": `198.51.100.${(hop++ % 250) + 1}` });

  async function verify(linkToken: string, email: string) {
    await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/request`,
      headers: fresh(),
      payload: { email },
    });
    const code = /is (\d{6})/.exec(world.email.sent.at(-1)?.text ?? "")?.[1];
    return world.app.inject({
      method: "POST",
      url: `/api/v1/p/${linkToken}/verify/confirm`,
      headers: fresh(),
      payload: { email, code },
    });
  }

  async function invite(campaignId: string, email: string): Promise<string> {
    const res = await world.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/invitations`,
      headers: admin(),
      payload: { emails: [email] },
    });
    expect(res.statusCode).toBe(200);
    return /invitation=([^\s&]+)/.exec(world.email.sent.at(-1)?.text ?? "")![1]!;
  }

  interface Grant {
    participantToken: string;
    sessionId: string;
    resume: boolean;
  }

  describe("the address hash", () => {
    it("is different in every campaign and never the platform-wide value", async () => {
      const a = await campaign("anonymous");
      const b = await campaign("anonymous");
      const email = `salt-${Date.now()}@ward.test`;

      expect((await verify(a.linkToken, email)).statusCode).toBe(200);
      expect((await verify(b.linkToken, email)).statusCode).toBe(200);

      const rows = await world.db.campaignEmailHash.findMany({
        where: { campaignId: { in: [a.id, b.id] } },
      });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.emailHash)).size).toBe(2);
      for (const r of rows) {
        expect(r.emailHash).toMatch(/^h2:/);
        expect(r.emailHash).not.toContain(world.crypto.hashEmail(email));
      }
      expect(rows.map((r) => r.emailHash).sort()).toEqual(
        [world.crypto.campaignEmailHash(email, a.id), world.crypto.campaignEmailHash(email, b.id)].sort(),
      );
    });

    it("is salted on invitations too, and an address is not invited twice", async () => {
      const c = await campaign("anonymous", "invitation");
      const email = `inv-${Date.now()}@ward.test`;

      await invite(c.id, email);
      const again = await world.app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${c.id}/invitations`,
        headers: admin(),
        payload: { emails: [email] },
      });

      const rows = await world.db.invitation.findMany({ where: { campaignId: c.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.emailHash).toBe(world.crypto.campaignEmailHash(email, c.id));
      expect(again.json<{ created: number; skipped: string[] }>()).toMatchObject({ created: 0 });
    });
  });

  describe("an anonymous response by email code", () => {
    it("stores no address and no hash on the participant, and a day-wide hash row", async () => {
      const c = await campaign("anonymous");
      const email = `anon-${Date.now()}@ward.test`;

      const grant = (await verify(c.linkToken, email)).json<Grant>();

      const participant = await world.db.participant.findFirstOrThrow({
        where: { campaignId: c.id },
      });
      expect(JSON.stringify(participant.fields)).not.toContain("_emailHash");
      expect(JSON.stringify(participant.fields)).not.toContain(email);
      const row = await world.db.campaignEmailHash.findFirstOrThrow({ where: { campaignId: c.id } });
      expect(row.createdAt.getTime()).toBe(startOfDay(row.createdAt));
      expect(row.resumeSeal).toBeTruthy();
      expect(row.ownerTag).toBe(world.crypto.participantTag(c.id, participant.id));
      // Nothing on the hash row names the session, and the seal is not the participant id in the clear.
      expect(JSON.stringify(row)).not.toContain(grant.sessionId);
      expect(JSON.stringify(row)).not.toContain(participant.id);
    });

    it("still resumes the same session when the same address verifies again, from any device", async () => {
      const c = await campaign("anonymous");
      const email = `resume-${Date.now()}@ward.test`;
      const first = (await verify(c.linkToken, email)).json<Grant>();

      const second = (await verify(c.linkToken, email)).json<Grant>();

      expect(second.sessionId).toBe(first.sessionId);
      expect(second.participantToken).not.toBe(first.participantToken);
      // A different address cannot reach it: it gets a response of its own.
      const other = (await verify(c.linkToken, `other-${Date.now()}@ward.test`)).json<Grant>();
      expect(other.sessionId).not.toBe(first.sessionId);
    });

    it("can be erased, hash row included, and the address may then take part again", async () => {
      const c = await campaign("anonymous");
      const email = `erase-${Date.now()}@ward.test`;
      const grant = (await verify(c.linkToken, email)).json<Grant>();
      const pt = { authorization: `Bearer pt.${grant.participantToken}` };

      const del = await world.app.inject({ method: "DELETE", url: "/api/v1/p/session", headers: pt });
      expect(del.statusCode).toBe(200);

      expect(await world.db.campaignEmailHash.count({ where: { campaignId: c.id } })).toBe(0);
      const again = await verify(c.linkToken, email);
      expect(again.statusCode).toBe(200);
      expect(again.json<Grant>().sessionId).not.toBe(grant.sessionId);
    });
  });

  describe("an anonymous response by personal invitation", () => {
    it("keeps no session link on the invitation and only the day it was opened", async () => {
      const c = await campaign("anonymous", "invitation");
      const email = `person-${Date.now()}@ward.test`;
      const token = await invite(c.id, email);

      const grant = (
        await world.app.inject({
          method: "POST",
          url: `/api/v1/p/${c.linkToken}/open`,
          payload: { invitationToken: token },
        })
      ).json<Grant>();

      const inv = await world.db.invitation.findFirstOrThrow({ where: { campaignId: c.id } });
      expect(inv.status).toBe("bound");
      expect(inv.sessionId).toBeNull();
      expect(inv.openedAt).not.toBeNull();
      expect(inv.openedAt!.getTime()).toBe(startOfDay(inv.openedAt!));
      expect(inv.email).toBeNull();
      // The staff view of invitations carries the same coarse date.
      const list = await world.app.inject({
        method: "GET",
        url: `/api/v1/campaigns/${c.id}/invitations`,
        headers: admin(),
      });
      const [shown] = list.json<{ invitations: { openedAt: string }[] }>().invitations;
      expect(Date.parse(shown!.openedAt)).toBe(startOfDay(inv.openedAt!));
      expect(JSON.stringify(list.json())).not.toContain(grant.sessionId);
    });

    it("resumes through the invitation link alone, and refuses a second response from it", async () => {
      const c = await campaign("anonymous", "invitation");
      const token = await invite(c.id, `back-${Date.now()}@ward.test`);
      const open = () =>
        world.app.inject({
          method: "POST",
          url: `/api/v1/p/${c.linkToken}/open`,
          payload: { invitationToken: token },
        });
      const first = (await open()).json<Grant>();

      const second = (await open()).json<Grant>();

      expect(second.sessionId).toBe(first.sessionId);
      expect(second.resume).toBe(false); // nothing said yet; the session is still `created`
      expect(await world.db.session.count({ where: { campaignId: c.id } })).toBe(1);
    });

    it("sends a link a person can open: the campaign's own link token, not a placeholder", async () => {
      const c = await campaign("anonymous", "invitation");

      await invite(c.id, `link-${Date.now()}@ward.test`);

      const text = world.email.sent.at(-1)?.text ?? "";
      expect(text).toContain(`/p/${c.linkToken}?invitation=`);
    });
  });

  describe("the staff list of sessions", () => {
    interface Row {
      id: string;
      createdAt: string;
      startedAt: string | null;
      lastActivityAt: string;
    }
    const list = async (id: string, query: string): Promise<Row[]> =>
      (
        await world.app.inject({
          method: "GET",
          url: `/api/v1/campaigns/${id}/sessions?${query}`,
          headers: admin(),
        })
      ).json<{ sessions: Row[] }>().sessions;

    it("shows an anonymous campaign's times as days and ignores the sort that would follow the clock", async () => {
      const c = await campaign("anonymous");
      for (let i = 0; i < 5; i++) await verify(c.linkToken, `list-${i}-${Date.now()}@ward.test`);

      const newestFirst = await list(c.id, "sort=createdAt&dir=desc");
      const oldestFirst = await list(c.id, "sort=createdAt&dir=asc");

      expect(newestFirst).toHaveLength(5);
      expect(newestFirst.map((s) => s.id)).toEqual(oldestFirst.map((s) => s.id));
      for (const s of newestFirst) {
        expect(Date.parse(s.createdAt)).toBe(startOfDay(new Date(s.createdAt)));
        expect(Date.parse(s.lastActivityAt)).toBe(startOfDay(new Date(s.lastActivityAt)));
      }
      // The same page twice is the same page: the order is stable, not random.
      const paged = [...(await list(c.id, "limit=2&offset=0")), ...(await list(c.id, "limit=3&offset=2"))];
      expect(paged.map((s) => s.id)).toEqual(newestFirst.map((s) => s.id));
    });

    it("keeps exact times and the requested order for an identified campaign", async () => {
      const c = await campaign("identified");
      for (let i = 0; i < 3; i++) await verify(c.linkToken, `named-${i}-${Date.now()}@ward.test`);

      const asc = await list(c.id, "sort=createdAt&dir=asc");
      const desc = await list(c.id, "sort=createdAt&dir=desc");

      expect(asc.map((s) => s.id)).toEqual(desc.map((s) => s.id).reverse());
      expect(asc.some((s) => Date.parse(s.createdAt) !== startOfDay(new Date(s.createdAt)))).toBe(true);
    });
  });

  describe("a participant who may choose", () => {
    it("loses the invitation's link to the session the moment they choose anonymity", async () => {
      const c = await campaign("participant_choice", "invitation");
      const token = await invite(c.id, `choice-${Date.now()}@ward.test`);
      const grant = (
        await world.app.inject({
          method: "POST",
          url: `/api/v1/p/${c.linkToken}/open`,
          payload: { invitationToken: token },
        })
      ).json<Grant>();
      expect((await world.db.invitation.findFirstOrThrow({ where: { campaignId: c.id } })).sessionId).toBe(
        grant.sessionId,
      );

      const consent = await world.app.inject({
        method: "POST",
        url: "/api/v1/p/session/consent",
        headers: { authorization: `Bearer pt.${grant.participantToken}` },
        payload: { consentVersion: "v1", participationChoice: "anonymous" },
      });

      expect(consent.statusCode).toBe(200);
      const inv = await world.db.invitation.findFirstOrThrow({ where: { campaignId: c.id } });
      expect(inv.sessionId).toBeNull();
      expect(inv.openedAt!.getTime()).toBe(startOfDay(inv.openedAt!));
      const participant = await world.db.participant.findFirstOrThrow({ where: { campaignId: c.id } });
      expect(JSON.stringify(participant.fields)).not.toContain("_emailHash");
    });
  });

  describe("an identified campaign", () => {
    it("keeps the address and the pointer, as before, with a campaign-salted hash", async () => {
      const c = await campaign("identified");
      const email = `known-${Date.now()}@ward.test`;

      await verify(c.linkToken, email);

      const participant = await world.db.participant.findFirstOrThrow({ where: { campaignId: c.id } });
      expect(participant.fields).toMatchObject({
        email,
        _emailHash: world.crypto.campaignEmailHash(email, c.id),
      });
      const resumed = (await verify(c.linkToken, email)).json<Grant>();
      expect(resumed.sessionId).toBe(
        (await world.db.session.findFirstOrThrow({ where: { campaignId: c.id } })).id,
      );
    });
  });

  describe("rows written before the salt", () => {
    /** Writes a response the way the previous build did: platform-wide hash, pointer, linked invitation. */
    async function legacyResponse(campaignId: string, email: string, withInvitation: boolean) {
      const legacy = world.crypto.hashEmail(email);
      const participant = await world.db.participant.create({
        data: {
          companyId: world.companyId,
          campaignId,
          fields: { _emailHash: legacy, role: "Nurse" },
          tokenHash: `legacy-${Date.now()}-${Math.random()}`,
        },
      });
      const session = await world.db.session.create({
        data: {
          companyId: world.companyId,
          templateId: world.templateId,
          campaignId,
          participantId: participant.id,
          status: "active",
        },
      });
      await world.db.campaignEmailHash.create({
        data: { companyId: world.companyId, campaignId, emailHash: legacy, createdAt: new Date() },
      });
      if (withInvitation)
        await world.db.invitation.create({
          data: {
            companyId: world.companyId,
            campaignId,
            emailHash: legacy,
            tokenHash: `legacy-inv-${Date.now()}-${Math.random()}`,
            status: "bound",
            sessionId: session.id,
            openedAt: new Date(),
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        });
      return { legacy, participant, session };
    }

    it("resumes by the old hash and upgrades the row when the address is typed", async () => {
      const c = await campaign("anonymous");
      const email = `old-${Date.now()}@ward.test`;
      const old = await legacyResponse(c.id, email, true);

      const grant = (await verify(c.linkToken, email)).json<Grant>();

      expect(grant).toMatchObject({ sessionId: old.session.id, resume: true });
      const row = await world.db.campaignEmailHash.findFirstOrThrow({ where: { campaignId: c.id } });
      expect(row.emailHash).toBe(world.crypto.campaignEmailHash(email, c.id));
      expect(row.resumeSeal).toBeTruthy();
      expect(row.ownerTag).toBe(world.crypto.participantTag(c.id, old.participant.id));
      expect(row.createdAt.getTime()).toBe(startOfDay(row.createdAt));
      const participant = await world.db.participant.findUniqueOrThrow({ where: { id: old.participant.id } });
      expect(JSON.stringify(participant.fields)).not.toContain("_emailHash");
      const inv = await world.db.invitation.findFirstOrThrow({ where: { campaignId: c.id } });
      expect(inv.emailHash).toBe(row.emailHash);
    });

    it("is retired when the anonymous campaign closes: no old hash survives", async () => {
      const c = await campaign("anonymous");
      await legacyResponse(c.id, `never-back-${Date.now()}@ward.test`, true);
      await world.db.emailCode.create({
        data: {
          companyId: world.companyId,
          campaignId: c.id,
          emailHash: "x",
          codeHash: "x",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const closed = await world.app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${c.id}/close`,
        headers: admin(),
      });

      expect(closed.statusCode).toBe(200);
      expect(await world.db.campaignEmailHash.count({ where: { campaignId: c.id } })).toBe(0);
      expect(await world.db.emailCode.count({ where: { campaignId: c.id } })).toBe(0);
      const participant = await world.db.participant.findFirstOrThrow({ where: { campaignId: c.id } });
      expect(JSON.stringify(participant.fields)).not.toContain("_emailHash");
      const inv = await world.db.invitation.findFirstOrThrow({ where: { campaignId: c.id } });
      expect(inv.sessionId).toBeNull();
      expect(inv.emailHash).toMatch(/^closed:/);
      expect(inv.openedAt!.getTime()).toBe(startOfDay(inv.openedAt!));
    });

    it("is left alone when an identified campaign closes", async () => {
      const c = await campaign("identified");
      const old = await legacyResponse(c.id, `named-${Date.now()}@ward.test`, false);

      await world.app.inject({
        method: "POST",
        url: `/api/v1/campaigns/${c.id}/close`,
        headers: admin(),
      });

      expect(await world.db.campaignEmailHash.count({ where: { campaignId: c.id } })).toBe(1);
      const participant = await world.db.participant.findUniqueOrThrow({ where: { id: old.participant.id } });
      expect(participant.fields).toMatchObject({ _emailHash: old.legacy });
    });
  });
});

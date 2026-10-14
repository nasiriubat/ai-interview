import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { shippedTemplate, withTenant } from "@aidp/db";
import { encode } from "@auth/core/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CampaignService } from "../src/modules/campaigns/service.js";
import { fakeModelServer, testWorld, type TestWorld } from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

type Page<K extends string, T> = Record<K, T[]> & { total: number; limit: number; offset: number };

/** A valid template row under a chosen key and name, built from a shipped template's body. */
function templateRow(
  companyId: string,
  key: string,
  name: string,
  status: string,
  from = "opportunity_discovery",
) {
  const t = shippedTemplate(from);
  if (!t) throw new Error(`shipped template ${from} missing`);
  return {
    companyId,
    key,
    version: 1,
    name,
    language: t.language,
    objective: t.objective,
    privacyMode: t.privacyMode,
    participantFields: t.participantFields,
    pathSelection: t.pathSelection,
    contextBlock: t.contextBlock,
    coverageAreas: t.coverageAreas,
    aiInstructions: t.aiInstructions,
    adaptivity: t.adaptivity,
    widgetPolicy: t.widgetPolicy,
    issueDetection: t.issueDetection,
    outputs: t.outputs,
    status,
  };
}

/**
 * D-79: staff lists search, sort and filter on the server. Every list is checked for a hit, a
 * miss, a filter, both sort directions, a 400 on an unknown sort, a `total` that counts the
 * filtered set, and a second tenant whose look-alike rows never come back.
 */
suite("staff list queries (D-79)", () => {
  let world: TestWorld;
  let model: { server: Server; url: string };
  let admin: { authorization: string };
  let operator: { authorization: string };
  let member: { authorization: string };
  let adminId: string;
  let memberId: string;
  let otherCompanyId: string;
  let otherCampaignId: string;
  let otherProviderId: string;
  const tag = randomBytes(4).toString("hex");
  const campaignIds = { alpha: "", beta: "", gamma: "", choice: "", anon: "" };
  const sessionIds = { ida: "", ivo: "", unstarted: "", carl: "", pat: "", anna: "" };

  const get = (url: string, headers = admin) =>
    world.app.inject({ method: "GET", url: `/api/v1${url}`, headers });

  beforeAll(async () => {
    model = await fakeModelServer(() => "ok");
    world = await testWorld(model.url);
    admin = { authorization: `Bearer ${world.adminToken}` };
    operator = { authorization: `Bearer ${world.operatorToken}` };
    const { db, companyId, templateId } = world;
    adminId = (await db.user.findFirstOrThrow({ where: { companyId, role: "admin" } })).id;

    const memberEmail = `member-${tag}@test.io`;
    memberId = (
      await db.user.create({
        data: { companyId, email: memberEmail, name: "Xavier Quill", role: "member" },
      })
    ).id;
    member = {
      authorization: `Bearer ${await encode({
        token: { email: memberEmail },
        secret: world.ctx.config.AUTH_SECRET,
        salt: "authjs.session-token",
      })}`,
    };

    // A second tenant whose rows look like ours: same names, same emails, same words.
    const other = await db.company.create({ data: { name: `Other ${tag}` } });
    otherCompanyId = other.id;
    const otherUser = await db.user.create({
      data: { companyId: other.id, email: `xavier-${tag}@other.io`, name: "Xavier Quill", role: "admin" },
    });
    const campaign = async (
      company: string,
      name: string,
      status: string,
      mode = "identified",
      createdAt?: Date,
    ): Promise<string> =>
      (
        await db.campaign.create({
          data: {
            companyId: company,
            templateId,
            name,
            status,
            participationMode: mode,
            linkTokenHash: randomBytes(16).toString("hex"),
            createdById: company === companyId ? adminId : otherUser.id,
            ...(createdAt ? { createdAt } : {}),
          },
        })
      ).id;
    campaignIds.alpha = await campaign(
      companyId,
      "Alpha pilot",
      "open",
      "identified",
      new Date("2026-01-01"),
    );
    campaignIds.beta = await campaign(
      companyId,
      "Beta rollout",
      "closed",
      "identified",
      new Date("2026-02-01"),
    );
    campaignIds.gamma = await campaign(
      companyId,
      "Gamma 50% test",
      "draft",
      "identified",
      new Date("2026-03-01"),
    );
    campaignIds.choice = await campaign(companyId, "Choice survey", "open", "participant_choice");
    campaignIds.anon = await campaign(companyId, "Anonymous pulse", "open", "anonymous");
    otherCampaignId = await campaign(other.id, "Alpha pilot", "open");

    const session = async (
      campaignId: string,
      fields: Record<string, string>,
      extra: { status?: string; startedAt?: Date; consentedAt?: Date; updatedAt?: Date } = {},
      company = companyId,
    ): Promise<string> => {
      const p = await db.participant.create({
        data: { companyId: company, campaignId, fields, tokenHash: randomBytes(16).toString("hex") },
      });
      const s = await db.session.create({
        data: {
          companyId: company,
          templateId,
          campaignId,
          participantId: p.id,
          status: extra.status ?? "active",
          ...(extra.startedAt ? { startedAt: extra.startedAt } : {}),
          ...(extra.consentedAt ? { consentedAt: extra.consentedAt } : {}),
        },
      });
      // updatedAt is kept by Prisma on every write; set it by hand to pin "last activity".
      if (extra.updatedAt)
        await db.$executeRaw`UPDATE "Session" SET "updatedAt" = ${extra.updatedAt} WHERE id = ${s.id}`;
      return s.id;
    };
    const c = new Date("2026-01-02");
    sessionIds.ida = await session(
      campaignIds.alpha,
      { email: `ida-${tag}@acme.io`, name: "Ida Identified" },
      { startedAt: new Date("2026-01-05"), consentedAt: c, updatedAt: new Date("2026-01-06") },
    );
    sessionIds.ivo = await session(
      campaignIds.alpha,
      { email: `ivo-${tag}@acme.io`, name: "Ivo Identified" },
      {
        status: "completed",
        startedAt: new Date("2026-01-03"),
        consentedAt: c,
        updatedAt: new Date("2026-01-09"),
      },
    );
    sessionIds.unstarted = await session(campaignIds.alpha, {}, { status: "created" });
    // participant_choice: identified once they consent as themselves; not before.
    sessionIds.carl = await session(campaignIds.choice, { email: `carl-${tag}@acme.io` }, { consentedAt: c });
    sessionIds.pat = await session(
      campaignIds.choice,
      { email: `pat-${tag}@acme.io` },
      { status: "created" },
    );
    // An anonymous campaign never stores an address; this one carries a stray one on purpose.
    sessionIds.anna = await session(
      campaignIds.anon,
      { email: `anna-${tag}@acme.io`, _emailHash: "h" },
      {
        consentedAt: c,
      },
    );
    await session(otherCampaignId, { email: `ida-${tag}@acme.io`, name: "Ida Identified" }, {}, other.id);

    otherProviderId = (
      await db.provider.create({
        data: { companyId: other.id, kind: "openai_compatible", name: "other", apiKeyEnc: "x", headers: {} },
      })
    ).id;
  });

  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  describe("/campaigns", () => {
    type R = Page<"campaigns", { id: string; name: string; status: string }>;

    it("searches the name case-insensitively and never returns another tenant's look-alike", async () => {
      const r = await get("/campaigns?q=ALPHA");
      expect(r.statusCode).toBe(200);
      expect(r.json<R>().campaigns.map((c) => c.id)).toEqual([campaignIds.alpha]);
      expect(r.json<R>().total).toBe(1);
      expect(r.json<R>().campaigns.map((c) => c.id)).not.toContain(otherCampaignId);
      expect((await get("/campaigns?q=nothing-like-this")).json<R>()).toMatchObject({
        campaigns: [],
        total: 0,
      });
    });

    it("treats LIKE wildcards in q as plain characters", async () => {
      expect((await get("/campaigns?q=50%25")).json<R>().campaigns.map((c) => c.name)).toEqual([
        "Gamma 50% test",
      ]);
      expect((await get("/campaigns?q=_")).json<R>().total).toBe(0);
      expect((await get("/campaigns?q=%25")).json<R>().total).toBe(1);
    });

    it("filters by status with a total that counts the filtered set, and pages within it", async () => {
      const open = await get("/campaigns?status=open");
      expect(open.json<R>().total).toBe(3);
      expect(open.json<R>().campaigns.every((c) => c.status === "open")).toBe(true);
      const page = await get("/campaigns?status=open&limit=1&offset=1&sort=name");
      expect(page.json<R>()).toMatchObject({ total: 3, limit: 1, offset: 1 });
      expect(page.json<R>().campaigns.map((c) => c.name)).toEqual(
        ["Anonymous pulse", "Alpha pilot", "Choice survey"].sort().slice(1, 2),
      );
    });

    it("sorts by name both ways, with name's own default direction when dir is absent", async () => {
      const names = ["Alpha pilot", "Anonymous pulse", "Beta rollout", "Choice survey", "Gamma 50% test"];
      expect((await get("/campaigns?sort=name")).json<R>().campaigns.map((c) => c.name)).toEqual(names);
      expect((await get("/campaigns?sort=name&dir=desc")).json<R>().campaigns.map((c) => c.name)).toEqual(
        [...names].reverse(),
      );
      const created = (await get("/campaigns?sort=createdAt&dir=asc&q=a"))
        .json<R>()
        .campaigns.map((c) => c.name);
      expect(created.slice(0, 3)).toEqual(["Alpha pilot", "Beta rollout", "Gamma 50% test"]);
    });

    it("carries invited, started and completed counts on every row of the page", async () => {
      const { db } = world;
      const invite = async (campaignId: string, n: string, status: string) =>
        db.invitation.create({
          data: {
            companyId: (await db.campaign.findUniqueOrThrow({ where: { id: campaignId } })).companyId,
            campaignId,
            emailHash: `${n}-${tag}`,
            tokenHash: randomBytes(16).toString("hex"),
            status,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        });
      await invite(campaignIds.alpha, "a", "sent");
      await invite(campaignIds.alpha, "b", "bound");
      await invite(campaignIds.alpha, "c", "revoked");
      await invite(otherCampaignId, "d", "sent");
      const deleted = await db.session.create({
        data: {
          companyId: world.companyId,
          templateId: world.templateId,
          campaignId: campaignIds.beta,
          status: "deleted",
        },
      });

      type WithStats = Page<
        "campaigns",
        { id: string; stats: { invited: number; started: number; completed: number } }
      >;
      const r = await get("/campaigns?sort=name");
      const stats = new Map(r.json<WithStats>().campaigns.map((c) => [c.id, c.stats]));
      // alpha: ida (active) and ivo (completed) started; the `created` one has not; one invite revoked.
      expect(stats.get(campaignIds.alpha)).toEqual({ invited: 2, started: 2, completed: 1 });
      // A deleted session is not counted as started.
      expect(stats.get(campaignIds.beta)).toEqual({ invited: 0, started: 0, completed: 0 });
      expect(stats.get(campaignIds.choice)).toEqual({ invited: 0, started: 1, completed: 0 });
      // The campaign page counts the same way, so the list and the detail never disagree. These
      // fixture campaigns have no link, which the detail route needs, so ask its stats directly.
      const { ctx } = world;
      const svc = new CampaignService(ctx.db, ctx.crypto, ctx.settings, ctx.email, ctx.config.PUBLIC_WEB_URL);
      for (const id of [campaignIds.alpha, campaignIds.beta, campaignIds.choice]) {
        const { invited, started, completed } = await withTenant(world.companyId, () =>
          svc.stats(world.companyId, id),
        );
        expect({ invited, started, completed }).toEqual(stats.get(id));
      }
      await db.session.delete({ where: { id: deleted.id } });
    });

    it("answers 400 to a sort field, direction or status it does not know, and to an overlong q", async () => {
      expect((await get("/campaigns?sort=linkTokenHash")).statusCode).toBe(400);
      expect((await get("/campaigns?sort=name;drop")).statusCode).toBe(400);
      expect((await get("/campaigns?dir=up")).statusCode).toBe(400);
      expect((await get("/campaigns?status=exploded")).statusCode).toBe(400);
      expect((await get(`/campaigns?q=${"x".repeat(201)}`)).statusCode).toBe(400);
      expect((await get(`/campaigns?q=${"x".repeat(200)}`)).statusCode).toBe(200);
    });
  });

  describe("/campaigns/:id/invitations (D-360)", () => {
    interface I {
      id: string;
      email: string | null;
      status: string;
    }
    type R = Page<"invitations", I>;
    const emails = ["amy", "bob", "cleo", "dan", "eve"].map((n) => `${n}-${tag}@acme.io`);
    const statuses = ["pending", "sent", "opened", "bound", "revoked"];
    let invitedCampaign = "";
    const url = (qs: string) => `/campaigns/${invitedCampaign}/invitations?${qs}`;

    beforeAll(async () => {
      invitedCampaign = (
        await world.db.campaign.create({
          data: {
            companyId: world.companyId,
            templateId: world.templateId,
            name: `Invited ${tag}`,
            status: "open",
            participationMode: "identified",
            linkTokenHash: randomBytes(16).toString("hex"),
            createdById: adminId,
          },
        })
      ).id;
      for (const [i, email] of emails.entries()) {
        await world.db.invitation.create({
          data: {
            companyId: world.companyId,
            campaignId: invitedCampaign,
            email,
            emailHash: `hash-${tag}-${i}`,
            tokenHash: `token-${tag}-${i}`,
            status: statuses[i]!,
            expiresAt: new Date("2030-01-01"),
            createdAt: new Date(2026, 0, 1 + i),
          },
        });
      }
    });

    it("pages with a total that counts the filtered set, in creation order by default", async () => {
      const first = (await get(url("limit=2"))).json<R>();
      expect(first.invitations.map((i) => i.email)).toEqual(emails.slice(0, 2));
      expect(first).toMatchObject({ total: 5, limit: 2, offset: 0 });
      const last = (await get(url("limit=2&offset=4"))).json<R>();
      expect(last.invitations.map((i) => i.email)).toEqual([emails[4]]);
    });

    it("filters by status, searches the address case-insensitively and sorts both ways", async () => {
      const opened = (await get(url("status=opened"))).json<R>();
      expect(opened.invitations.map((i) => i.email)).toEqual([emails[2]]);
      expect(opened.total).toBe(1);
      const found = (await get(url(`q=CLEO-${tag}`))).json<R>();
      expect(found.invitations.map((i) => i.email)).toEqual([emails[2]]);
      expect((await get(url("q=nobody-here"))).json<R>().total).toBe(0);
      const desc = (await get(url("sort=email&dir=desc&limit=1"))).json<R>();
      expect(desc.invitations[0]?.email).toBe(emails[4]);
    });

    it("never lets a member find or order by an address it is not shown", async () => {
      const all = (await get(url(""), member)).json<R>();
      expect(all.invitations.every((i) => i.email === null)).toBe(true);
      expect(all.total).toBe(5);
      const probe = (await get(url(`q=amy-${tag}`), member)).json<R>();
      expect(probe).toMatchObject({ invitations: [], total: 0 });
      const byEmail = (await get(url("sort=email&dir=desc"), member)).json<R>();
      const byCreation = (await get(url("sort=createdAt&dir=desc"), member)).json<R>();
      expect(byEmail.invitations.map((i) => i.id)).toEqual(byCreation.invitations.map((i) => i.id));
    });

    it("answers 400 to an unknown sort or status and 404 to another tenant's campaign", async () => {
      expect((await get(url("sort=tokenHash"))).statusCode).toBe(400);
      expect((await get(url("status=exploded"))).statusCode).toBe(400);
      expect((await get(url(`q=${"x".repeat(201)}`))).statusCode).toBe(400);
      const cross = await get(`/campaigns/${otherCampaignId}/invitations?q=amy`);
      expect(cross.statusCode).toBe(404);
    });
  });

  describe("/campaigns/:id/sessions", () => {
    interface S {
      id: string;
      status: string;
      participantEmail: string | null;
      participantName: string | null;
      lastActivityAt: string;
    }
    type R = Page<"sessions", S>;
    const url = (key: keyof typeof campaignIds, qs: string) =>
      `/campaigns/${campaignIds[key]}/sessions?${qs}`;

    it("finds an identified participant by email or name, case-insensitively, and shows who it is", async () => {
      const byEmail = await get(url("alpha", `q=IDA-${tag}`));
      expect(byEmail.json<R>().sessions.map((s) => s.id)).toEqual([sessionIds.ida]);
      expect(byEmail.json<R>().total).toBe(1);
      expect(byEmail.json<R>().sessions[0]).toMatchObject({
        participantEmail: `ida-${tag}@acme.io`,
        participantName: "Ida Identified",
      });
      expect((await get(url("alpha", "q=ivo identified"))).json<R>().sessions.map((s) => s.id)).toEqual([
        sessionIds.ivo,
      ]);
      expect((await get(url("alpha", "q=nobody"))).json<R>().total).toBe(0);
    });

    it("never finds or names an anonymous participant by email, even one with a stray address", async () => {
      const r = await get(url("anon", `q=anna-${tag}`));
      expect(r.json<R>()).toMatchObject({ sessions: [], total: 0 });
      expect((await get(url("anon", "q=acme.io"))).json<R>().total).toBe(0);
      const all = await get(url("anon", ""));
      expect(all.json<R>().sessions).toHaveLength(1);
      expect(all.json<R>().sessions[0]).toMatchObject({ participantEmail: null, participantName: null });
      expect(JSON.stringify(all.json<R>())).not.toContain("anna-");
      // The session id is still a way to find it: support gets ids, not names.
      expect((await get(url("anon", `q=${sessionIds.anna}`))).json<R>().sessions.map((s) => s.id)).toEqual([
        sessionIds.anna,
      ]);
    });

    it("identifies a participant_choice participant only after they have consented", async () => {
      expect((await get(url("choice", `q=carl-${tag}`))).json<R>().sessions.map((s) => s.id)).toEqual([
        sessionIds.carl,
      ]);
      expect((await get(url("choice", `q=pat-${tag}`))).json<R>().total).toBe(0);
      const pat = (await get(url("choice", ""))).json<R>().sessions.find((s) => s.id === sessionIds.pat);
      expect(pat).toMatchObject({ participantEmail: null });
    });

    it("filters by status and sorts by start and last activity both ways, never-started last", async () => {
      const completed = await get(url("alpha", "status=completed"));
      expect(completed.json<R>().sessions.map((s) => s.id)).toEqual([sessionIds.ivo]);
      expect(completed.json<R>().total).toBe(1);

      const started = (qs: string) =>
        get(url("alpha", qs)).then((r) => r.json<R>().sessions.map((s) => s.id));
      expect(await started("sort=startedAt")).toEqual([sessionIds.ida, sessionIds.ivo, sessionIds.unstarted]);
      expect(await started("sort=startedAt&dir=asc")).toEqual([
        sessionIds.ivo,
        sessionIds.ida,
        sessionIds.unstarted,
      ]);
      const active = await started("sort=lastActivity&dir=asc&status=active");
      expect(active).toEqual([sessionIds.ida]);
      const byActivity = await started("sort=lastActivity");
      expect(byActivity.indexOf(sessionIds.ivo)).toBeLessThan(byActivity.indexOf(sessionIds.ida));
    });

    it("answers 400 to an unknown sort and 404 to another tenant's campaign", async () => {
      expect((await get(url("alpha", "sort=participant.fields"))).statusCode).toBe(400);
      expect((await get(url("alpha", "status=archived"))).statusCode).toBe(400);
      expect((await get(`/campaigns/${otherCampaignId}/sessions?q=ida`)).statusCode).toBe(404);
    });
  });

  describe("/requirements", () => {
    type R = Page<"sessions", { id: string; title: string; status: string }>;

    beforeAll(async () => {
      const { db, companyId } = world;
      const template = await db.interviewTemplate.create({
        data: templateRow(
          companyId,
          "requirements_discovery",
          "Requirements",
          "published",
          "requirements_discovery",
        ),
      });
      const make = (ownerUserId: string, title: string, status: string, createdAt: Date) =>
        db.session.create({
          data: {
            companyId,
            templateId: template.id,
            ownerUserId,
            sourceKind: "text",
            title,
            status,
            createdAt,
          },
        });
      await make(adminId, "Ward notes", "active", new Date("2026-04-01"));
      await make(adminId, "Warehouse scanner", "completed", new Date("2026-04-02"));
      await make(memberId, "Ward rota", "active", new Date("2026-04-03"));
      await make(adminId, "Ward deleted", "deleted", new Date("2026-04-04"));
    });

    it("searches the title, filters by status and sorts both ways", async () => {
      const ward = await get("/requirements?q=ward&sort=title");
      expect(ward.json<R>().sessions.map((s) => s.title)).toEqual(["Ward notes", "Ward rota"]);
      expect(ward.json<R>().total).toBe(2);
      const desc = await get("/requirements?q=war&sort=title&dir=desc");
      expect(desc.json<R>().sessions.map((s) => s.title)).toEqual([
        "Warehouse scanner",
        "Ward rota",
        "Ward notes",
      ]);
      const done = await get("/requirements?status=completed");
      expect(done.json<R>()).toMatchObject({ total: 1 });
      expect(done.json<R>().sessions[0]?.title).toBe("Warehouse scanner");
      expect((await get("/requirements?q=scanner&status=active")).json<R>().total).toBe(0);
    });

    it("keeps a member to their own sessions whatever they search for, and never lists deleted ones", async () => {
      const mine = await get("/requirements?q=ward", member);
      expect(mine.json<R>().sessions.map((s) => s.title)).toEqual(["Ward rota"]);
      expect(mine.json<R>().total).toBe(1);
      expect((await get("/requirements?q=deleted")).json<R>().total).toBe(0);
      expect((await get("/requirements?status=deleted")).statusCode).toBe(400);
      expect((await get("/requirements?sort=ownerUserId")).statusCode).toBe(400);
    });
  });

  describe("/templates", () => {
    type R = Page<"templates", { id: string; name: string; status: string; companyId: string | null }>;

    beforeAll(async () => {
      const { db, companyId } = world;
      const make = (company: string, key: string, name: string, status: string) =>
        db.interviewTemplate.create({ data: templateRow(company, key, name, status) });
      await make(companyId, `zeta_${tag}`, `Zeta custom ${tag}`, "draft");
      await make(companyId, `zulu_${tag}`, `Zulu custom ${tag}`, "published");
      await make(companyId, `old_${tag}`, `Zeta archived ${tag}`, "archived");
      await make(otherCompanyId, `zeta_${tag}`, `Zeta custom ${tag}`, "draft");
    });

    it("pages, and searches name or key within this tenant and the platform only", async () => {
      const r = await get(`/templates?q=${tag}&origin=tenant`);
      expect(r.statusCode).toBe(200);
      expect(r.json<R>().templates.map((t) => t.name)).toEqual([`Zeta custom ${tag}`, `Zulu custom ${tag}`]);
      expect(r.json<R>()).toMatchObject({ total: 2, limit: 50, offset: 0 });
      expect(r.json<R>().templates.every((t) => t.companyId === world.companyId)).toBe(true);
      expect((await get(`/templates?q=zulu_${tag}`)).json<R>().total).toBe(1);
      const one = await get(`/templates?q=${tag}&limit=1&offset=1`);
      expect(one.json<R>()).toMatchObject({ total: 2, limit: 1, offset: 1 });
    });

    it("leaves archived versions out unless asked for, and filters by status", async () => {
      expect((await get(`/templates?q=archived ${tag}`)).json<R>().total).toBe(0);
      const archived = await get(`/templates?q=${tag}&status=archived`);
      expect(archived.json<R>().templates.map((t) => t.name)).toEqual([`Zeta archived ${tag}`]);
      expect((await get(`/templates?q=${tag}&status=draft`)).json<R>().total).toBe(1);
      expect((await get(`/templates?q=${tag}&origin=platform`)).json<R>().total).toBe(0);
    });

    it("sorts by name both ways and rejects an unknown sort", async () => {
      const names = (qs: string) =>
        get(`/templates?q=${tag}&${qs}`).then((r) => r.json<R>().templates.map((t) => t.name));
      expect(await names("sort=name")).toEqual([`Zeta custom ${tag}`, `Zulu custom ${tag}`]);
      expect(await names("sort=name&dir=desc")).toEqual([`Zulu custom ${tag}`, `Zeta custom ${tag}`]);
      expect((await get("/templates?sort=aiInstructions")).statusCode).toBe(400);
    });
  });

  describe("/users", () => {
    type R = Page<"users", { id: string; email: string; role: string; companyId: string }>;

    it("searches email and name inside the tenant, filters by role, and sorts both ways", async () => {
      const r = await get("/users?q=xavier");
      expect(r.json<R>().users.map((u) => u.id)).toEqual([memberId]);
      expect(r.json<R>().total).toBe(1);
      expect((await get(`/users?q=member-${tag}`)).json<R>().total).toBe(1);
      expect((await get(`/users?q=@other.io`)).json<R>().total).toBe(0);

      const members = await get("/users?role=member");
      expect(members.json<R>().users.every((u) => u.role === "member")).toBe(true);
      expect(members.json<R>().total).toBe(1);
      expect((await get("/users?role=admin")).json<R>().total).toBe(1);

      const asc = (await get("/users?sort=email")).json<R>().users.map((u) => u.email);
      const desc = (await get("/users?sort=email&dir=desc")).json<R>().users.map((u) => u.email);
      expect(asc).toEqual([...asc].sort());
      expect(desc).toEqual([...asc].reverse());
      expect((await get("/users?sort=password")).statusCode).toBe(400);
      expect((await get("/users?role=owner")).statusCode).toBe(400);
    });
  });

  describe("/audit", () => {
    type R = Page<
      "entries",
      { action: string; targetId: string; actorEmail: string | null; createdAt: string }
    >;

    beforeAll(async () => {
      const { db, companyId } = world;
      const at = (d: string) => new Date(d);
      await db.auditLog.createMany({
        data: [
          {
            companyId,
            actorId: adminId,
            action: "campaign.create",
            targetType: "campaign",
            targetId: "c1",
            createdAt: at("2025-05-01T10:00:00Z"),
          },
          {
            companyId,
            actorId: adminId,
            action: "campaign.open",
            targetType: "campaign",
            targetId: "c1",
            createdAt: at("2025-05-02T10:00:00Z"),
          },
          {
            companyId,
            actorId: memberId,
            action: "template.update",
            targetType: "template",
            targetId: "t1",
            createdAt: at("2025-05-03T23:30:00Z"),
          },
          {
            companyId,
            actorId: null,
            action: "prices_x.update",
            targetType: "provider",
            targetId: "p1",
            createdAt: at("2025-05-04T10:00:00Z"),
          },
          {
            companyId: otherCompanyId,
            actorId: null,
            action: "campaign.create",
            targetType: "campaign",
            targetId: "c1",
            createdAt: at("2025-05-01T10:00:00Z"),
          },
        ],
      });
    });
    const window = "from=2025-05-01&to=2025-05-04";

    it("searches the action, the target id and the actor, within the tenant only", async () => {
      const byAction = await get(`/audit?${window}&q=campaign`);
      expect(byAction.json<R>().entries.map((e) => e.action)).toEqual(["campaign.open", "campaign.create"]);
      expect(byAction.json<R>().total).toBe(2);
      expect((await get(`/audit?${window}&q=t1`)).json<R>().entries.map((e) => e.action)).toEqual([
        "template.update",
      ]);
      const byActor = await get(`/audit?${window}&q=xavier`);
      expect(byActor.json<R>().entries.map((e) => e.action)).toEqual(["template.update"]);
      expect(byActor.json<R>().entries[0]?.actorEmail).toBe(`member-${tag}@test.io`);
      expect((await get(`/audit?${window}&q=nothing`)).json<R>().total).toBe(0);
    });

    it("filters by one action, a family of actions, a target type and a date range", async () => {
      expect((await get(`/audit?${window}&action=campaign.open`)).json<R>().total).toBe(1);
      expect((await get(`/audit?${window}&action=campaign.`)).json<R>().total).toBe(2);
      // `_` in a family is a character, not a LIKE wildcard.
      expect((await get(`/audit?${window}&action=prices_x.`)).json<R>().total).toBe(1);
      expect((await get(`/audit?${window}&action=pricesxx.`)).json<R>().total).toBe(0);
      expect((await get(`/audit?${window}&targetType=template`)).json<R>().total).toBe(1);
      // A bare `to` date covers the whole day, so the 23:30 entry on the 3rd is in.
      expect(
        (await get("/audit?from=2025-05-02&to=2025-05-03")).json<R>().entries.map((e) => e.action),
      ).toEqual(["template.update", "campaign.open"]);
      expect(
        (await get("/audit?from=2025-05-02T00:00:00Z&to=2025-05-03T12:00:00%2B00:00")).json<R>().total,
      ).toBe(1);
    });

    it("sorts by time both ways and by action, and rejects what it does not understand", async () => {
      const asc = (await get(`/audit?${window}&sort=createdAt&dir=asc`))
        .json<R>()
        .entries.map((e) => e.action);
      expect(asc).toEqual(["campaign.create", "campaign.open", "template.update", "prices_x.update"]);
      const byAction = (await get(`/audit?${window}&sort=action`)).json<R>().entries.map((e) => e.action);
      expect(byAction).toEqual(["campaign.create", "campaign.open", "prices_x.update", "template.update"]);
      expect((await get(`/audit?sort=diff`)).statusCode).toBe(400);
      expect((await get(`/audit?action=DROP TABLE`)).statusCode).toBe(400);
      expect((await get(`/audit?from=yesterday`)).statusCode).toBe(400);
      expect((await get(`/audit?from=2025-05-04&to=2025-05-01`)).statusCode).toBe(400);
    });
  });

  describe("/budgets", () => {
    type R = Page<"budgets", { scope: string; scopeId: string; limitCents: number }>;

    beforeAll(async () => {
      const { db, companyId } = world;
      await db.budget.create({
        data: { companyId, scope: "campaign", scopeId: campaignIds.alpha, limitCents: 500, period: "total" },
      });
      await db.budget.create({
        data: { companyId, scope: "campaign", scopeId: campaignIds.beta, limitCents: 900, period: "month" },
      });
      await db.budget.create({
        data: {
          companyId: otherCompanyId,
          scope: "campaign",
          scopeId: otherCampaignId,
          limitCents: 1,
          period: "total",
        },
      });
    });

    it("finds a campaign budget by the campaign's name and filters by scope and period", async () => {
      const alpha = await get("/budgets?q=alpha");
      expect(alpha.json<R>().budgets.map((b) => b.scopeId)).toEqual([campaignIds.alpha]);
      expect(alpha.json<R>().total).toBe(1);
      expect((await get(`/budgets?q=${campaignIds.beta}`)).json<R>().total).toBe(1);
      expect((await get(`/budgets?q=${otherCampaignId}`)).json<R>().total).toBe(0);
      expect((await get("/budgets?scope=campaign")).json<R>().total).toBe(2);
      expect((await get("/budgets?scope=campaign&period=month")).json<R>().total).toBe(1);
      expect((await get("/budgets?scope=tenant")).json<R>().total).toBe(1);
    });

    it("sorts by limit both ways and rejects an unknown sort", async () => {
      const limits = (qs: string) =>
        get(`/budgets?scope=campaign&${qs}`).then((r) => r.json<R>().budgets.map((b) => b.limitCents));
      expect(await limits("sort=limitCents")).toEqual([900, 500]);
      expect(await limits("sort=limitCents&dir=asc")).toEqual([500, 900]);
      expect((await get("/budgets?sort=companyId")).statusCode).toBe(400);
      expect((await get("/budgets?scope=planet")).statusCode).toBe(400);
    });
  });

  describe("/providers/:id/prices", () => {
    type R = Page<"prices", { model: string; source: string }>;
    let providerId: string;

    beforeAll(async () => {
      providerId = (await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } })).id;
      await world.db.modelPrice.createMany({
        data: [
          {
            providerId,
            model: "gpt-x_1",
            inputPerMtok: 5,
            cachedInputPerMtok: 5,
            outputPerMtok: 9,
            source: "provider",
          },
          {
            providerId,
            model: "claude-foo",
            inputPerMtok: 3,
            cachedInputPerMtok: 3,
            outputPerMtok: 15,
            source: "seed",
          },
        ],
      });
    });

    it("searches the model id, filters by source and sorts both ways", async () => {
      const r = await get(`/providers/${providerId}/prices?q=CLAUDE`);
      expect(r.json<R>().prices.map((p) => p.model)).toEqual(["claude-foo"]);
      expect(r.json<R>().total).toBe(1);
      expect((await get(`/providers/${providerId}/prices?q=_`)).json<R>().prices.map((p) => p.model)).toEqual(
        ["gpt-x_1"],
      );
      expect(
        (await get(`/providers/${providerId}/prices?source=admin`)).json<R>().prices.map((p) => p.model),
      ).toEqual(["fake-model"]);
      const models = (qs: string) =>
        get(`/providers/${providerId}/prices?${qs}`).then((x) => x.json<R>().prices.map((p) => p.model));
      expect(await models("sort=model")).toEqual(["claude-foo", "fake-model", "gpt-x_1"]);
      expect(await models("sort=model&dir=desc")).toEqual(["gpt-x_1", "fake-model", "claude-foo"]);
      expect(await models("sort=inputPerMtok&dir=desc")).toEqual(["gpt-x_1", "claude-foo", "fake-model"]);
      expect((await get(`/providers/${providerId}/prices?sort=providerId`)).statusCode).toBe(400);
    });

    it("does not reach another tenant's provider", async () => {
      expect((await get(`/providers/${otherProviderId}/prices?q=a`)).statusCode).toBe(404);
    });
  });

  describe("/campaigns/:id/analyses", () => {
    type R = Page<"analyses", { version: number; status: string }>;

    it("filters by status and sorts by version both ways", async () => {
      await world.db.analysis.createMany({
        data: [
          { companyId: world.companyId, campaignId: campaignIds.alpha, version: 1, status: "done" },
          { companyId: world.companyId, campaignId: campaignIds.alpha, version: 2, status: "failed" },
        ],
      });
      const url = `/campaigns/${campaignIds.alpha}/analyses`;
      expect((await get(url)).json<R>().analyses.map((a) => a.version)).toEqual([2, 1]);
      expect((await get(`${url}?sort=version&dir=asc`)).json<R>().analyses.map((a) => a.version)).toEqual([
        1, 2,
      ]);
      const done = await get(`${url}?status=done`);
      expect(done.json<R>()).toMatchObject({ total: 1 });
      expect((await get(`${url}?sort=stats`)).statusCode).toBe(400);
      expect((await get(`/campaigns/${otherCampaignId}/analyses`)).statusCode).toBe(404);
    });
  });

  describe("/operator/tenants", () => {
    type R = Page<"tenants", { id: string; name: string; status: string }>;

    it("searches names across tenants, filters by status and sorts both ways", async () => {
      await world.db.company.create({ data: { name: `Zed ${tag}`, status: "suspended" } });
      const r = await get(`/operator/tenants?q=${tag}&sort=name`, operator);
      expect(r.statusCode).toBe(200);
      expect(r.json<R>().tenants.map((t) => t.name)).toEqual([`Other ${tag}`, `Zed ${tag}`]);
      expect(r.json<R>().total).toBe(2);
      const desc = await get(`/operator/tenants?q=${tag}&sort=name&dir=desc`, operator);
      expect(desc.json<R>().tenants.map((t) => t.name)).toEqual([`Zed ${tag}`, `Other ${tag}`]);
      expect((await get(`/operator/tenants?q=${tag}&status=suspended`, operator)).json<R>().total).toBe(1);
      expect((await get(`/operator/tenants?q=${otherCompanyId}`, operator)).json<R>().total).toBe(1);
      expect((await get("/operator/tenants?sort=monthlyBudgetCents", operator)).statusCode).toBe(400);
      // A tenant admin cannot list tenants at all, search or not.
      expect((await get(`/operator/tenants?q=${tag}`)).statusCode).toBe(403);
    });
  });
});

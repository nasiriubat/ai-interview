import { escapeLike, tenantBatch } from "@aidp/db";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff, staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";
import { CampaignService } from "./service.js";

const Id = z.object({ id: z.string() });

/** `/campaigns` (D-79): `q` matches the name. */
export const CampaignList = listSpec({
  sort: { createdAt: "desc", name: "asc", status: "asc" },
  defaultSort: "createdAt",
  filters: { status: z.enum(["draft", "open", "analyzing", "closed"]).optional() },
});

/**
 * `/campaigns/:id/sessions` (D-79). `q` matches the session id exactly, and the participant's
 * `name` or `email` field only where that participant is identified: the campaign is
 * `identified`, or it is `participant_choice` and the participant has consented (consent is where
 * they choose). An anonymous participant keeps no email, and even a stray one is never searched,
 * so a search cannot be used to learn which session an anonymous person wrote.
 */
export const CampaignSessionList = listSpec({
  sort: { createdAt: "desc", startedAt: "desc", lastActivity: "desc", status: "asc" },
  defaultSort: "createdAt",
  columns: { lastActivity: "updatedAt" },
  nullable: ["startedAt"],
  filters: {
    status: z.enum(["created", "consented", "active", "paused", "completed", "deleted"]).optional(),
  },
});

/** Whether a session's participant may be named on a staff screen or found by a search. */
function identified(mode: string, consented: boolean): boolean {
  return mode === "identified" || (mode === "participant_choice" && consented);
}

/** The identity a staff list may show, under the same rule the search follows. */
function visibleIdentity(
  mode: string,
  consented: boolean,
  fields: unknown,
): { participantName: string | null; participantEmail: string | null } {
  const f = (fields ?? {}) as Record<string, unknown>;
  const show = identified(mode, consented);
  const str = (v: unknown) => (show && typeof v === "string" && v ? v : null);
  return { participantName: str(f.name), participantEmail: str(f.email) };
}

export async function campaignRoutes(app: App, ctx: AppContext): Promise<void> {
  const svc = new CampaignService(ctx.db, ctx.crypto, ctx.settings, ctx.email, ctx.config.PUBLIC_WEB_URL);

  /** Campaign rows never expose the link token hash. */
  const publicCampaign = <T extends { linkTokenHash: string }>({
    linkTokenHash: _hash,
    ...c
  }: T): Omit<T, "linkTokenHash"> => c;
  app.get(
    "/campaigns",
    { preHandler: requireStaff(), schema: { querystring: listQuery(CampaignList) } },
    async (req) => {
      const { campaigns, total } = await svc.list(req.companyId, {
        limit: req.query.limit,
        offset: req.query.offset,
        q: searchTerm(req.query.q),
        status: req.query.status,
        orderBy: listOrder<Prisma.CampaignOrderByWithRelationInput, typeof req.query.sort>(
          CampaignList,
          req.query,
        ),
      });
      const stats = await svc.listStats(
        req.companyId,
        campaigns.map((c) => c.id),
      );
      return {
        campaigns: campaigns.map((c) => ({ ...publicCampaign(c), stats: stats.get(c.id) })),
        total,
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );

  app.post(
    "/campaigns",
    {
      preHandler: requireStaff("admin"),
      schema: {
        body: z.object({
          templateId: z.string(),
          name: z.string().min(1).max(200),
          participationMode: z.enum(["identified", "anonymous", "participant_choice"]).optional(),
          verification: z.enum(["invitation", "email_code", "open"]).optional(),
          allowedEmailDomains: z.array(z.string()).optional(),
          maxTurns: z.number().int().min(5).max(500).optional(),
          completionThreshold: z.number().int().min(1).optional(),
          expiresAt: z.coerce.date().optional(),
        }),
      },
    },
    async (req, reply) => {
      const actor = staff(req).userId;
      const { campaign, link } = await svc.create(req.companyId, req.body, actor);
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: actor,
        action: "campaign.create",
        targetType: "campaign",
        targetId: campaign.id,
        diff: { name: campaign.name },
      });
      return reply
        .status(201)
        .send({ campaign: { ...publicCampaign(campaign), link: { url: link } }, link: { url: link } });
    },
  );

  app.get("/campaigns/:id", { preHandler: requireStaff(), schema: { params: Id } }, async (req) => {
    const campaign = await svc.get(req.companyId, req.params.id);
    const [url, stats] = await Promise.all([
      svc.link(req.companyId, campaign.id),
      svc.stats(req.companyId, campaign.id),
    ]);
    // link and stats travel inside the record as well, so a client that unwraps `campaign` keeps them.
    return { campaign: { ...publicCampaign(campaign), link: { url }, stats }, link: { url }, stats };
  });

  app.patch(
    "/campaigns/:id",
    {
      preHandler: requireStaff("admin"),
      schema: {
        params: Id,
        body: z.object({
          name: z.string().min(1).max(200).optional(),
          allowedEmailDomains: z.array(z.string()).optional(),
          maxTurns: z.number().int().min(5).max(500).optional(),
          completionThreshold: z.number().int().min(1).optional(),
          expiresAt: z.coerce.date().optional(),
        }),
      },
    },
    async (req) => {
      const campaign = await svc.update(req.companyId, req.params.id, req.body);
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: staff(req).userId,
        action: "campaign.update",
        targetType: "campaign",
        targetId: campaign.id,
        diff: req.body,
      });
      return { campaign };
    },
  );

  for (const status of ["open", "closed"] as const) {
    app.post(
      `/campaigns/:id/${status === "open" ? "open" : "close"}`,
      { preHandler: requireStaff("admin"), schema: { params: Id } },
      async (req) => {
        const campaign = await svc.setStatus(req.companyId, req.params.id, status);
        await audit(ctx.db, {
          companyId: req.companyId,
          actorId: staff(req).userId,
          action: `campaign.${status}`,
          targetType: "campaign",
          targetId: campaign.id,
        });
        return { campaign };
      },
    );
  }

  app.post(
    "/campaigns/:id/invitations",
    {
      preHandler: requireStaff("admin"),
      schema: { params: Id, body: z.object({ emails: z.array(z.string()).min(1).max(1000) }) },
    },
    async (req) => {
      const p = staff(req);
      const result = await svc.invite(req.companyId, req.params.id, req.body.emails, p.email);
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: p.userId,
        action: "campaign.invite",
        targetType: "campaign",
        targetId: req.params.id,
        diff: { created: result.created },
      });
      return result;
    },
  );

  app.get(
    "/campaigns/:id/invitations",
    { preHandler: requireStaff(), schema: { params: Id } },
    async (req) => ({
      invitations: (await svc.invitations(req.companyId, req.params.id)).map((i) => ({
        id: i.id,
        email: i.email,
        status: i.status,
        sentAt: i.sentAt,
        openedAt: i.openedAt,
        expiresAt: i.expiresAt,
      })),
    }),
  );

  app.post(
    "/campaigns/:id/invitations/:invId/remind",
    {
      preHandler: requireStaff("admin"),
      schema: { params: z.object({ id: z.string(), invId: z.string() }) },
    },
    async (req) => {
      await svc.remind(req.companyId, req.params.id, req.params.invId);
      return { ok: true as const };
    },
  );

  app.post(
    "/campaigns/:id/invitations/:invId/revoke",
    {
      preHandler: requireStaff("admin"),
      schema: { params: z.object({ id: z.string(), invId: z.string() }) },
    },
    async (req) => {
      await svc.revoke(req.companyId, req.params.id, req.params.invId);
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: staff(req).userId,
        action: "invitation.revoke",
        targetType: "invitation",
        targetId: req.params.invId,
      });
      return { ok: true as const };
    },
  );

  app.get(
    "/campaigns/:id/sessions",
    {
      preHandler: requireStaff(),
      schema: { params: Id, querystring: listQuery(CampaignSessionList) },
    },
    async (req) => {
      const campaign = await svc.get(req.companyId, req.params.id);
      const mode = campaign.participationMode;
      const q = searchTerm(req.query.q);
      const fieldMatch = (key: "name" | "email", term: string): Prisma.SessionWhereInput => ({
        participant: { fields: { path: [key], string_contains: escapeLike(term), mode: "insensitive" } },
      });
      // Identity is searchable only where it would be shown (see CampaignSessionList).
      const identity: Prisma.SessionWhereInput[] =
        q === undefined || (mode !== "identified" && mode !== "participant_choice")
          ? []
          : [
              {
                ...(mode === "identified" ? {} : { consentedAt: { not: null } }),
                OR: [fieldMatch("name", q), fieldMatch("email", q)],
              },
            ];
      const where: Prisma.SessionWhereInput = {
        campaignId: campaign.id,
        companyId: req.companyId,
        ...(req.query.status ? { status: req.query.status } : {}),
        ...(q === undefined ? {} : { OR: [{ id: q }, ...identity] }),
      };
      const [sessions, total] = await tenantBatch(ctx.db, [
        ctx.db.session.findMany({
          where,
          orderBy: listOrder<Prisma.SessionOrderByWithRelationInput, typeof req.query.sort>(
            CampaignSessionList,
            req.query,
          ),
          take: req.query.limit,
          skip: req.query.offset,
          select: {
            id: true,
            status: true,
            state: true,
            startedAt: true,
            endedAt: true,
            createdAt: true,
            updatedAt: true,
            consentedAt: true,
            modePreference: true,
            participant: { select: { fields: true } },
          },
        }),
        ctx.db.session.count({ where }),
      ]);
      // Costs for this page only, rather than every session the campaign ever had.
      const costs = sessions.length
        ? await ctx.db.llmCall.groupBy({
            by: ["sessionId"],
            where: { companyId: req.companyId, sessionId: { in: sessions.map((s) => s.id) } },
            _sum: { costCents: true },
          })
        : [];
      const costOf = new Map(costs.map((c) => [c.sessionId, c._sum.costCents ?? 0]));
      return {
        sessions: sessions.map((s) => {
          const st = s.state as { turnCount?: number; coverage?: Record<string, { status: string }> };
          const covered = Object.values(st.coverage ?? {}).filter(
            (c) => c.status === "covered" || c.status === "skipped",
          ).length;
          return {
            id: s.id,
            status: s.status,
            turns: st.turnCount ?? 0,
            areasCovered: covered,
            mode: s.modePreference,
            costCents: costOf.get(s.id) ?? 0,
            ...visibleIdentity(mode, s.consentedAt !== null, s.participant?.fields),
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            createdAt: s.createdAt,
            lastActivityAt: s.updatedAt,
          };
        }),
        total,
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );
}

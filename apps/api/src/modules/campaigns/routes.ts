import { createHash } from "node:crypto";
import { escapeLike, tenantBatch } from "@aidp/db";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
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

/**
 * What an anonymous campaign's session list may say about time and order (D-142). A timestamp to
 * the second, or an order that follows creation, can be read against the day an invitation was
 * opened or the order addresses were invited, which would put a name to a session. So times are a
 * day wide and the order is a stable one that follows no clock.
 */
function toDay(d: Date | null): Date | null {
  return d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null;
}
const stableKey = (campaignId: string, id: string): string =>
  createHash("sha256").update(`${campaignId}:${id}`).digest("hex");

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

  /**
   * The campaign as staff see it, field by field (D-144). A row with one column taken off was how
   * `linkTokenHash` stayed out; a column added to the table would have gone out with it. The share
   * link is not here: it is an administrator's, and added by the routes that may show it.
   */
  const publicCampaign = (c: {
    id: string;
    templateId: string;
    name: string;
    participationMode: string;
    verification: string;
    allowedEmailDomains: unknown;
    expiresAt: Date | null;
    maxTurns: number;
    completionThreshold: number;
    weights: unknown;
    status: string;
    createdById: string;
    createdAt: Date;
  }) => ({
    id: c.id,
    templateId: c.templateId,
    name: c.name,
    participationMode: c.participationMode,
    verification: c.verification,
    allowedEmailDomains: c.allowedEmailDomains,
    expiresAt: c.expiresAt,
    maxTurns: c.maxTurns,
    completionThreshold: c.completionThreshold,
    weights: c.weights,
    status: c.status,
    createdById: c.createdById,
    createdAt: c.createdAt,
  });
  /** An administrator, or the platform operator acting for one. */
  const mayManage = (req: Parameters<typeof staff>[0]): boolean => {
    const role = staff(req).role;
    return role === "admin" || role === "platform_operator";
  };
  app.get(
    "/campaigns",
    { ...guard.staff(), schema: { querystring: listQuery(CampaignList) } },
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
      ...guard.admin(),
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

  app.get("/campaigns/:id", { ...guard.staff(), schema: { params: Id } }, async (req) => {
    const campaign = await svc.get(req.companyId, req.params.id);
    const stats = await svc.stats(req.companyId, campaign.id);
    // The share link lets anyone who holds it start an interview, so only administrators are given
    // it (D-144); a member sees the campaign without it.
    if (!mayManage(req)) return { campaign: { ...publicCampaign(campaign), stats }, stats };
    const url = await svc.link(req.companyId, campaign.id);
    // link and stats travel inside the record as well, so a client that unwraps `campaign` keeps them.
    return { campaign: { ...publicCampaign(campaign), link: { url }, stats }, link: { url }, stats };
  });

  app.patch(
    "/campaigns/:id",
    {
      ...guard.admin(),
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
      return { campaign: publicCampaign(campaign) };
    },
  );

  for (const status of ["open", "closed"] as const) {
    app.post(
      `/campaigns/:id/${status === "open" ? "open" : "close"}`,
      { ...guard.admin(), schema: { params: Id } },
      async (req) => {
        const campaign = await svc.setStatus(req.companyId, req.params.id, status);
        await audit(ctx.db, {
          companyId: req.companyId,
          actorId: staff(req).userId,
          action: `campaign.${status}`,
          targetType: "campaign",
          targetId: campaign.id,
        });
        return { campaign: publicCampaign(campaign) };
      },
    );
  }

  app.post(
    "/campaigns/:id/invitations",
    {
      ...guard.admin(),
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

  app.get("/campaigns/:id/invitations", { ...guard.staff(), schema: { params: Id } }, async (req) => ({
    invitations: (await svc.invitations(req.companyId, req.params.id)).map((i) => ({
      id: i.id,
      // Who was invited is an administrator's to know; a member sees the invitations' state (D-144).
      email: mayManage(req) ? i.email : null,
      status: i.status,
      sentAt: i.sentAt,
      openedAt: i.openedAt,
      expiresAt: i.expiresAt,
    })),
  }));

  app.post(
    "/campaigns/:id/invitations/:invId/remind",
    {
      ...guard.admin(),
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
      ...guard.admin(),
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
      ...guard.staff(),
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
      // An anonymous campaign is paged in a stable order that follows no clock (see `stableKey`):
      // the matching ids are ordered here, and the page's rows are read afterwards.
      const pageIds =
        mode === "anonymous"
          ? (await ctx.db.session.findMany({ where, select: { id: true } }))
              .map((s) => s.id)
              .sort((x, y) => stableKey(campaign.id, x).localeCompare(stableKey(campaign.id, y)))
              .slice(req.query.offset, req.query.offset + req.query.limit)
          : null;
      const [sessionRows, total] = await tenantBatch(ctx.db, [
        ctx.db.session.findMany({
          where: pageIds ? { ...where, id: { in: pageIds } } : where,
          orderBy: listOrder<Prisma.SessionOrderByWithRelationInput, typeof req.query.sort>(
            CampaignSessionList,
            req.query,
          ),
          ...(pageIds ? {} : { take: req.query.limit, skip: req.query.offset }),
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
      const sessions = pageIds
        ? [...sessionRows].sort((a, b) => pageIds.indexOf(a.id) - pageIds.indexOf(b.id))
        : sessionRows;
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
            // A person who is not named on this screen is not given a time to the second either.
            ...(identified(mode, s.consentedAt !== null)
              ? {
                  startedAt: s.startedAt,
                  endedAt: s.endedAt,
                  createdAt: s.createdAt,
                  lastActivityAt: s.updatedAt,
                }
              : {
                  startedAt: toDay(s.startedAt),
                  endedAt: toDay(s.endedAt),
                  createdAt: toDay(s.createdAt),
                  lastActivityAt: toDay(s.updatedAt),
                }),
          };
        }),
        total,
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );
}

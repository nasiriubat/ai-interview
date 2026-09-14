import { tenantBatch } from "@aidp/db";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff, staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { PageQuery } from "../../lib/pagination.js";
import { CampaignService } from "./service.js";

const Id = z.object({ id: z.string() });

export async function campaignRoutes(app: App, ctx: AppContext): Promise<void> {
  const svc = new CampaignService(ctx.db, ctx.crypto, ctx.settings, ctx.email, ctx.config.PUBLIC_WEB_URL);

  /** Campaign rows never expose the link token hash. */
  const publicCampaign = <T extends { linkTokenHash: string }>({
    linkTokenHash: _hash,
    ...c
  }: T): Omit<T, "linkTokenHash"> => c;
  app.get("/campaigns", { preHandler: requireStaff(), schema: { querystring: PageQuery } }, async (req) => {
    const { campaigns, total } = await svc.list(req.companyId, req.query);
    return {
      campaigns: campaigns.map(publicCampaign),
      total,
      limit: req.query.limit,
      offset: req.query.offset,
    };
  });

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
    { preHandler: requireStaff(), schema: { params: Id, querystring: PageQuery } },
    async (req) => {
      await svc.get(req.companyId, req.params.id);
      const where = { campaignId: req.params.id, companyId: req.companyId };
      const [sessions, total] = await tenantBatch(ctx.db, [
        ctx.db.session.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: req.query.limit,
          skip: req.query.offset,
          select: {
            id: true,
            status: true,
            state: true,
            startedAt: true,
            endedAt: true,
            createdAt: true,
            modePreference: true,
          },
        }),
        ctx.db.session.count({ where }),
      ]);
      const costs = await ctx.db.llmCall.groupBy({
        by: ["sessionId"],
        where: { campaignId: req.params.id },
        _sum: { costCents: true },
      });
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
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            createdAt: s.createdAt,
          };
        }),
        total,
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );
}

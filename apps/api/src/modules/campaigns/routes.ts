import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { CampaignListQuery, CampaignSessionListQuery } from "./service.js";

const Id = z.object({ id: z.string() });

export async function campaignRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.services.campaigns;

  /** Campaign rows never expose the link token hash. */
  const publicCampaign = <T extends { linkTokenHash: string }>({
    linkTokenHash: _hash,
    ...c
  }: T): Omit<T, "linkTokenHash"> => c;
  app.get("/campaigns", { ...guard.staff(), schema: { querystring: CampaignListQuery } }, async (req) => {
    const { campaigns, total } = await svc.list(req.companyId, req.query);
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
  });

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
      await ctx.services.audit.record(req.companyId, {
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
      await ctx.services.audit.record(req.companyId, {
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
      { ...guard.admin(), schema: { params: Id } },
      async (req) => {
        const campaign = await svc.setStatus(req.companyId, req.params.id, status);
        await ctx.services.audit.record(req.companyId, {
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
      ...guard.admin(),
      schema: { params: Id, body: z.object({ emails: z.array(z.string()).min(1).max(1000) }) },
    },
    async (req) => {
      const p = staff(req);
      const result = await svc.invite(req.companyId, req.params.id, req.body.emails, p.email);
      await ctx.services.audit.record(req.companyId, {
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
      email: i.email,
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
      // A reminder sends mail to a named person, so it is an admin action like the invitation is.
      await ctx.services.audit.record(req.companyId, {
        actorId: staff(req).userId,
        action: "invitation.remind",
        targetType: "invitation",
        targetId: req.params.invId,
        diff: { campaignId: req.params.id },
      });
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
      await ctx.services.audit.record(req.companyId, {
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
      schema: { params: Id, querystring: CampaignSessionListQuery },
    },
    async (req) => svc.sessionsPage(req.companyId, req.params.id, req.query),
  );
}

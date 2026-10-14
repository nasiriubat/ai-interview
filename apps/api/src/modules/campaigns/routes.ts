import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { CampaignListQuery, CampaignSessionListQuery } from "./service.js";

const Id = z.object({ id: z.string() });

export async function campaignRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.services.campaigns;

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
      await ctx.services.audit.record(req.companyId, {
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
        await ctx.services.audit.record(req.companyId, {
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

  /**
   * The sessions as a spreadsheet (D-236). Administrators only, because it is a bulk copy of who
   * took part; each download is a row in the audit log with the number of rows and nothing of the
   * content.
   */
  app.get("/campaigns/:id/sessions.csv", { ...guard.admin(), schema: { params: Id } }, async (req, reply) => {
    const out = await svc.sessionsCsv(req.companyId, req.params.id);
    await ctx.services.audit.record(req.companyId, {
      actorId: staff(req).userId,
      action: "campaign.sessions_export",
      targetType: "campaign",
      targetId: req.params.id,
      diff: { rows: out.rows },
    });
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${out.filename}"`)
      .header("cache-control", "no-store")
      .send(out.body);
  });

  app.get(
    "/campaigns/:id/sessions",
    {
      ...guard.staff(),
      schema: { params: Id, querystring: CampaignSessionListQuery },
    },
    async (req) => svc.sessionsPage(req.companyId, req.params.id, req.query),
  );
}

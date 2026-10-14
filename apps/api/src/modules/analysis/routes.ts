import { AnalysisInProgressError, OpportunityNotFoundError } from "@aidp/core";
import { OpportunityOverrideSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { AppError, notFound } from "../../lib/errors.js";
import { expensiveLimit } from "../../lib/rate-limit.js";
import { AnalysisListQuery } from "./service.js";

const Id = z.object({ id: z.string() });

/** Analysis runs, opportunities, and the report (contract 17). */
export async function analysisRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.analysis;
  const reads = ctx.services.analysisQueries;
  const audit = ctx.services.audit;

  app.post(
    "/campaigns/:id/analyses",
    { ...guard.admin(expensiveLimit(ctx.config)), schema: { params: Id } },
    async (req, reply) => {
      await reads.assertCampaign(req.companyId, req.params.id);
      try {
        const run = await svc.queue(req.companyId, req.params.id, staff(req).userId);
        await audit.record(req.companyId, {
          actorId: staff(req).userId,
          action: "analysis.start",
          targetType: "campaign",
          targetId: req.params.id,
          diff: { analysisId: run.id },
        });
        const analysis = await reads.summary(req.companyId, run.id);
        return await reply.status(202).send({ analysis });
      } catch (e) {
        if (e instanceof AnalysisInProgressError)
          throw new AppError("conflict", e.message, { analysisId: e.analysisId });
        throw e;
      }
    },
  );

  app.get(
    "/campaigns/:id/analyses",
    { ...guard.staff(), schema: { params: Id, querystring: AnalysisListQuery } },
    async (req) => reads.list(req.companyId, req.params.id, req.query),
  );

  app.get("/analyses/:id", { ...guard.staff(), schema: { params: Id } }, async (req) =>
    reads.detail(req.companyId, staff(req).role, req.params.id),
  );

  app.get(
    "/analyses/:id/diff/:otherId",
    { ...guard.staff(), schema: { params: z.object({ id: z.string(), otherId: z.string() }) } },
    async (req) => reads.diff(req.companyId, req.params.id, req.params.otherId),
  );

  const wrapNotFound = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const value = await fn();
      return value;
    } catch (e) {
      if (e instanceof OpportunityNotFoundError) throw notFound("Opportunity");
      throw e;
    }
  };

  app.patch(
    "/opportunities/:id",
    { ...guard.admin(), schema: { params: Id, body: OpportunityOverrideSchema } },
    async (req) => {
      await wrapNotFound(() => svc.override(req.companyId, req.params.id, req.body));
      await audit.record(req.companyId, {
        actorId: staff(req).userId,
        action: "opportunity.override",
        targetType: "opportunity",
        targetId: req.params.id,
        diff: req.body,
      });
      return reads.opportunity(req.companyId, req.params.id);
    },
  );

  app.post(
    "/opportunities/:id/status",
    {
      ...guard.admin(),
      schema: { params: Id, body: z.object({ status: z.enum(["new", "shortlisted", "dismissed"]) }) },
    },
    async (req) => {
      await wrapNotFound(() => svc.setStatus(req.companyId, req.params.id, req.body.status));
      await audit.record(req.companyId, {
        actorId: staff(req).userId,
        action: `opportunity.${req.body.status}`,
        targetType: "opportunity",
        targetId: req.params.id,
      });
      return reads.opportunity(req.companyId, req.params.id);
    },
  );

  app.post("/opportunities/:id/promote", { ...guard.admin(), schema: { params: Id } }, async (req) => {
    const p = staff(req);
    // Promoting an opportunity starts one template from another's output: that is chaining (D-187).
    const chaining = await ctx.settings.get("features.chaining", [
      { scope: "tenant", scopeId: req.companyId },
    ]);
    if (!chaining)
      throw new AppError("feature_disabled", "Promoting opportunities is turned off for this organization");
    const { sessionId, handoff } = await wrapNotFound(() =>
      svc.promote(req.companyId, req.params.id, p.userId),
    );
    await audit.record(req.companyId, {
      actorId: p.userId,
      action: "opportunity.promote",
      targetType: "opportunity",
      targetId: req.params.id,
      diff: { sessionId },
    });
    return { session: { id: sessionId, templateKey: "requirements_discovery" }, handoff };
  });
}

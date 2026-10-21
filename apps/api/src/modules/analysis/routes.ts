import {
  AnalysisInProgressError,
  ClusterEditRefusedError,
  OpportunityNotFoundError,
  RerunRequiredError,
} from "@aidp/core";
import {
  MergeBodySchema,
  OpportunityOverrideSchema,
  ReportReviewBodySchema,
  SplitBodySchema,
} from "@aidp/shared";
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

  /** Department comparison under the anonymity rule (FR-17): groups below k are never named. */
  app.get("/analyses/:id/departments", { ...guard.staff(), schema: { params: Id } }, async (req) =>
    reads.departments(req.companyId, staff(req).role, req.params.id),
  );

  /**
   * The review step before a report is shared (D-478): an administrator marks the report of a
   * version reviewed, or returns it to draft. Exports print which it is.
   */
  app.post(
    "/analyses/:id/review",
    { ...guard.admin(), schema: { params: Id, body: ReportReviewBodySchema } },
    async (req) => {
      const p = staff(req);
      const { review, before, reportId } = await reads.review(req.companyId, req.params.id, req.body.status, {
        id: p.userId,
        email: p.email,
      });
      await audit.record(req.companyId, {
        actorId: p.userId,
        action: req.body.status === "reviewed" ? "report.review" : "report.review_reopen",
        targetType: "analysis",
        targetId: req.params.id,
        diff: { reportId, before, after: review.status },
      });
      return { review };
    },
  );

  app.get(
    "/analyses/:id/diff/:otherId",
    { ...guard.staff(), schema: { params: z.object({ id: z.string(), otherId: z.string() }) } },
    async (req) => reads.diff(req.companyId, req.params.id, req.params.otherId),
  );

  /** Turns the core's refusals into the API's: 404 for what is not this tenant's, 409 and 400 for the rest. */
  const wrapNotFound = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      const value = await fn();
      return value;
    } catch (e) {
      if (e instanceof OpportunityNotFoundError) throw notFound("Opportunity");
      if (e instanceof AnalysisInProgressError)
        throw new AppError("conflict", e.message, { reason: "in_progress", analysisId: e.analysisId });
      if (e instanceof RerunRequiredError)
        throw new AppError("conflict", e.message, { reason: "rerun_required" });
      if (e instanceof ClusterEditRefusedError)
        throw new AppError(e.reason === "validation" ? "validation" : "conflict", e.message, {
          reason: e.reason,
        });
      throw e;
    }
  };

  app.patch(
    "/opportunities/:id",
    { ...guard.admin(), schema: { params: Id, body: OpportunityOverrideSchema } },
    async (req) => {
      const { reviewReopened } = await wrapNotFound(() =>
        svc.override(req.companyId, req.params.id, req.body),
      );
      // A title or summary on its own is a rename (FR-18); anything else is an override of the
      // assessment. The audit log tells the two apart.
      const renameOnly =
        (req.body.title !== undefined || req.body.summary !== undefined) &&
        req.body.solutionClass === undefined &&
        req.body.factors === undefined;
      await audit.record(req.companyId, {
        actorId: staff(req).userId,
        action: renameOnly ? "cluster.rename" : "opportunity.override",
        targetType: "opportunity",
        targetId: req.params.id,
        // A reviewed report says something else now, so it is a draft again (D-478).
        diff: { ...req.body, ...(reviewReopened ? { reportReview: "draft" } : {}) },
      });
      return reads.opportunity(req.companyId, req.params.id);
    },
  );

  app.post(
    "/analyses/:id/opportunities/merge",
    { ...guard.admin(), schema: { params: Id, body: MergeBodySchema } },
    async (req, reply) => {
      const p = staff(req);
      const { analysis, editId } = await wrapNotFound(() =>
        svc.merge(req.companyId, req.params.id, req.body.opportunityIds, req.body.title, p.userId),
      );
      await audit.record(req.companyId, {
        actorId: p.userId,
        action: "cluster.merge",
        targetType: "analysis",
        targetId: req.params.id,
        diff: { opportunityIds: req.body.opportunityIds, editId, newAnalysisId: analysis.id },
      });
      return reply.status(202).send({ analysis: await reads.summary(req.companyId, analysis.id), editId });
    },
  );

  app.get("/opportunities/:id/split-proposal", { ...guard.admin(), schema: { params: Id } }, async (req) =>
    wrapNotFound(() => svc.splitProposal(req.companyId, req.params.id)),
  );

  app.post(
    "/opportunities/:id/split",
    { ...guard.admin(), schema: { params: Id, body: SplitBodySchema } },
    async (req, reply) => {
      const p = staff(req);
      const { analysis, editId } = await wrapNotFound(() =>
        svc.split(req.companyId, req.params.id, req.body.parts, p.userId),
      );
      await audit.record(req.companyId, {
        actorId: p.userId,
        action: "cluster.split",
        targetType: "opportunity",
        targetId: req.params.id,
        diff: { parts: req.body.parts.map((x) => x.length), editId, newAnalysisId: analysis.id },
      });
      return reply.status(202).send({ analysis: await reads.summary(req.companyId, analysis.id), editId });
    },
  );

  app.get("/campaigns/:id/cluster-edits", { ...guard.staff(), schema: { params: Id } }, async (req) => {
    await reads.assertCampaign(req.companyId, req.params.id);
    return { edits: await svc.listEdits(req.companyId, req.params.id) };
  });

  app.delete(
    "/campaigns/:id/cluster-edits/:editId",
    { ...guard.admin(), schema: { params: z.object({ id: z.string(), editId: z.string() }) } },
    async (req, reply) => {
      await reads.assertCampaign(req.companyId, req.params.id);
      const p = staff(req);
      const { analysis } = await wrapNotFound(() =>
        svc.undoEdit(req.companyId, req.params.id, req.params.editId, p.userId),
      );
      await audit.record(req.companyId, {
        actorId: p.userId,
        action: "cluster.edit.undo",
        targetType: "campaign",
        targetId: req.params.id,
        diff: { editId: req.params.editId, newAnalysisId: analysis.id },
      });
      return reply.status(202).send({ analysis: await reads.summary(req.companyId, analysis.id) });
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

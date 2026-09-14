import { AnalysisInProgressError, OpportunityNotFoundError } from "@aidp/core";
import { tenantBatch } from "@aidp/db";
import { OpportunityOverrideSchema, rankScore } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff, staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { AppError, notFound } from "../../lib/errors.js";
import { PageQuery } from "../../lib/pagination.js";

const Id = z.object({ id: z.string() });

/** Analysis runs, opportunities, and the report (contract 17). */
export async function analysisRoutes(app: App, ctx: AppContext): Promise<void> {
  const svc = ctx.analysis;

  const campaignOf = async (companyId: string, campaignId: string) => {
    const c = await ctx.db.campaign.findFirst({ where: { id: campaignId, companyId } });
    if (!c) throw notFound("Campaign");
    return c;
  };
  const analysisView = (a: {
    id: string;
    campaignId: string;
    version: number;
    status: string;
    preliminary: boolean;
    stats: unknown;
    startedAt: Date | null;
    finishedAt: Date | null;
    createdAt: Date;
  }) => ({
    id: a.id,
    campaignId: a.campaignId,
    version: a.version,
    status: a.status,
    preliminary: a.preliminary,
    stats: a.stats,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    createdAt: a.createdAt,
  });

  app.post(
    "/campaigns/:id/analyses",
    { preHandler: requireStaff("admin"), schema: { params: Id } },
    async (req, reply) => {
      await campaignOf(req.companyId, req.params.id);
      try {
        const run = await svc.queue(req.companyId, req.params.id, staff(req).userId);
        await audit(ctx.db, {
          companyId: req.companyId,
          actorId: staff(req).userId,
          action: "analysis.start",
          targetType: "campaign",
          targetId: req.params.id,
          diff: { analysisId: run.id },
        });
        const analysis = await ctx.db.analysis.findUniqueOrThrow({ where: { id: run.id } });
        return await reply.status(202).send({ analysis: analysisView(analysis) });
      } catch (e) {
        if (e instanceof AnalysisInProgressError)
          throw new AppError("conflict", e.message, { analysisId: e.analysisId });
        throw e;
      }
    },
  );

  app.get(
    "/campaigns/:id/analyses",
    { preHandler: requireStaff(), schema: { params: Id, querystring: PageQuery } },
    async (req) => {
      await campaignOf(req.companyId, req.params.id);
      const where = { campaignId: req.params.id };
      const [analyses, total] = await tenantBatch(ctx.db, [
        ctx.db.analysis.findMany({
          where,
          orderBy: { version: "desc" },
          take: req.query.limit,
          skip: req.query.offset,
        }),
        ctx.db.analysis.count({ where }),
      ]);
      return {
        analyses: analyses.map(analysisView),
        total,
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );

  const loadAnalysis = async (companyId: string, id: string) => {
    const a = await ctx.db.analysis.findFirst({
      where: { id, campaign: { companyId } },
      include: {
        campaign: true,
        opportunities: { include: { evidence: true }, orderBy: { rankScore: "desc" } },
        reports: { orderBy: { version: "desc" }, take: 1 },
      },
    });
    if (!a) throw notFound("Analysis");
    return a;
  };

  const opportunityView = (
    o: Awaited<ReturnType<typeof loadAnalysis>>["opportunities"][number],
    weights: Parameters<typeof rankScore>[1],
  ) => ({
    id: o.id,
    analysisId: o.analysisId,
    clusterKey: o.clusterKey,
    title: o.title,
    summary: o.summary,
    solutionClass: o.solutionClass,
    factors: o.factors,
    rationale: o.rationale,
    rankScore: rankScore(o.factors as Parameters<typeof rankScore>[0], weights),
    status: o.status,
    adminOverride: o.adminOverride,
    stats: o.stats,
    dataNeeded: o.dataNeeded,
    risks: o.risks,
    ...(o.whyNotAi ? { whyNotAi: o.whyNotAi } : {}),
    promotedSessionId: o.promotedSessionId,
    evidence: o.evidence.map((e) => ({ factId: e.factId, snippet: e.snippet, anonymized: e.anonymized })),
  });

  app.get("/analyses/:id", { preHandler: requireStaff(), schema: { params: Id } }, async (req) => {
    const a = await loadAnalysis(req.companyId, req.params.id);
    if (a.preliminary && staff(req).role === "member") {
      const visible = await ctx.settings.get("analysis.preliminaryVisibleToMembers", [
        { scope: "tenant", scopeId: req.companyId },
      ]);
      if (!visible) throw new AppError("forbidden", "Preliminary results are not visible to members");
    }
    const weights = await svc.weightsFor(a.campaignId, req.companyId);
    const report = a.reports[0];
    return {
      analysis: analysisView(a),
      opportunities: a.opportunities
        .map((o) => opportunityView(o, weights))
        .sort((x, y) => y.rankScore - x.rankScore),
      report: report
        ? {
            id: report.id,
            analysisId: report.analysisId,
            version: report.version,
            markdown: report.markdown,
            sections: report.sections,
            createdAt: report.createdAt,
          }
        : null,
    };
  });

  app.get(
    "/analyses/:id/diff/:otherId",
    { preHandler: requireStaff(), schema: { params: z.object({ id: z.string(), otherId: z.string() }) } },
    async (req) => {
      const [a, b] = await Promise.all([
        loadAnalysis(req.companyId, req.params.id),
        loadAnalysis(req.companyId, req.params.otherId),
      ]);
      if (a.campaignId !== b.campaignId)
        throw new AppError("validation", "Analyses belong to different campaigns");
      const weights = await svc.weightsFor(a.campaignId, req.companyId);
      const byKey = (x: typeof a) =>
        new Map(x.opportunities.map((o) => [o.clusterKey, opportunityView(o, weights)]));
      const am = byKey(a);
      const bm = byKey(b);
      const added = [...am.values()].filter((o) => !bm.has(o.clusterKey));
      const removed = [...bm.values()].filter((o) => !am.has(o.clusterKey));
      const changed = [...am.values()]
        .filter((o) => bm.has(o.clusterKey))
        .map((after) => ({ before: bm.get(after.clusterKey), after }))
        .filter(
          ({ before, after }) =>
            before &&
            (before.rankScore !== after.rankScore ||
              before.solutionClass !== after.solutionClass ||
              before.title !== after.title),
        );
      return { added, removed, changed };
    },
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
  const opportunityById = async (companyId: string, id: string) => {
    const o = await ctx.db.opportunity.findFirst({
      where: { id, analysis: { campaign: { companyId } } },
      include: { evidence: true, analysis: true },
    });
    if (!o) throw notFound("Opportunity");
    const weights = await svc.weightsFor(o.analysis.campaignId, companyId);
    return { opportunity: opportunityView(o, weights) };
  };

  app.patch(
    "/opportunities/:id",
    { preHandler: requireStaff("admin"), schema: { params: Id, body: OpportunityOverrideSchema } },
    async (req) => {
      await wrapNotFound(() => svc.override(req.companyId, req.params.id, req.body));
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: staff(req).userId,
        action: "opportunity.override",
        targetType: "opportunity",
        targetId: req.params.id,
        diff: req.body,
      });
      return opportunityById(req.companyId, req.params.id);
    },
  );

  app.post(
    "/opportunities/:id/status",
    {
      preHandler: requireStaff("admin"),
      schema: { params: Id, body: z.object({ status: z.enum(["new", "shortlisted", "dismissed"]) }) },
    },
    async (req) => {
      await wrapNotFound(() => svc.setStatus(req.companyId, req.params.id, req.body.status));
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: staff(req).userId,
        action: `opportunity.${req.body.status}`,
        targetType: "opportunity",
        targetId: req.params.id,
      });
      return opportunityById(req.companyId, req.params.id);
    },
  );

  app.post(
    "/opportunities/:id/promote",
    { preHandler: requireStaff("admin"), schema: { params: Id } },
    async (req) => {
      const p = staff(req);
      const { sessionId, handoff } = await wrapNotFound(() =>
        svc.promote(req.companyId, req.params.id, p.userId),
      );
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: p.userId,
        action: "opportunity.promote",
        targetType: "opportunity",
        targetId: req.params.id,
        diff: { sessionId },
      });
      return { session: { id: sessionId, templateKey: "requirements_discovery" }, handoff };
    },
  );
}

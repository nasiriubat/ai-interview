import type { AnalysisService, SettingsService } from "@aidp/core";
import { tenantBatch } from "@aidp/db";
import { rankScore, toListResponse, type ListEnvelope } from "@aidp/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError, notFound } from "../../lib/errors.js";
import { listOrder, listQuery, listSpec } from "../../lib/pagination.js";

/** `/campaigns/:id/analyses` (D-79): runs are numbered, so there is nothing to search. */
export const AnalysisList = listSpec({
  sort: { version: "desc", createdAt: "desc" },
  defaultSort: "version",
  filters: { status: z.enum(["queued", "running", "done", "failed"]).optional() },
});

export const AnalysisListQuery = listQuery(AnalysisList);
export type AnalysisListQuery = z.output<typeof AnalysisListQuery>;

type Weights = Parameters<typeof rankScore>[1];

interface AnalysisRow {
  id: string;
  campaignId: string;
  version: number;
  status: string;
  preliminary: boolean;
  stats: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface AnalysisView {
  id: string;
  campaignId: string;
  version: number;
  status: string;
  preliminary: boolean;
  stats: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export const analysisView = (a: AnalysisRow): AnalysisView => ({
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

type OpportunityRow = Prisma.OpportunityGetPayload<{ include: { evidence: true } }>;

const opportunityView = (o: OpportunityRow, weights: Weights) => ({
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
  // A row with no text is how a cluster below k is recorded (it keeps the hand-off's link to the
  // process facts); it says nothing to a reader and is not returned (D-143).
  evidence: o.evidence
    .filter((e) => e.snippet !== "")
    .map((e) => ({ factId: e.factId, snippet: e.snippet, anonymized: e.anonymized })),
});

export type OpportunityView = ReturnType<typeof opportunityView>;

export interface AnalysisDetail {
  analysis: AnalysisView;
  opportunities: OpportunityView[];
  report: {
    id: string;
    analysisId: string;
    version: number;
    markdown: string;
    sections: unknown;
    createdAt: Date;
  } | null;
}

export interface AnalysisDiff {
  added: OpportunityView[];
  removed: OpportunityView[];
  changed: { before: OpportunityView | undefined; after: OpportunityView }[];
}

/**
 * The read side of analysis: runs of a campaign, one run with its opportunities and report, and
 * the diff of two runs. Writes (queue, override, promote) stay in `AnalysisService` in core.
 */
export class AnalysisQueryService {
  constructor(
    private readonly db: PrismaClient,
    private readonly analysis: AnalysisService,
    private readonly settings: SettingsService,
  ) {}

  /** Throws 404 unless the campaign belongs to this tenant. */
  async assertCampaign(companyId: string, campaignId: string): Promise<void> {
    const c = await this.db.campaign.findFirst({
      where: { id: campaignId, companyId },
      select: { id: true },
    });
    if (!c) throw notFound("Campaign");
  }

  /** The run row as the API shows it, for the `202` that starts one. */
  async summary(companyId: string, id: string): Promise<AnalysisView> {
    const a = await this.db.analysis.findFirstOrThrow({ where: { id, campaign: { companyId } } });
    return analysisView(a);
  }

  async list(
    companyId: string,
    campaignId: string,
    query: AnalysisListQuery,
  ): Promise<ListEnvelope<"analyses", AnalysisView>> {
    await this.assertCampaign(companyId, campaignId);
    const where: Prisma.AnalysisWhereInput = {
      campaignId,
      campaign: { companyId },
      ...(query.status ? { status: query.status } : {}),
    };
    const [analyses, total] = await tenantBatch(this.db, [
      this.db.analysis.findMany({
        where,
        orderBy: listOrder<Prisma.AnalysisOrderByWithRelationInput, typeof query.sort>(AnalysisList, query),
        take: query.limit,
        skip: query.offset,
      }),
      this.db.analysis.count({ where }),
    ]);
    return toListResponse("analyses", analyses.map(analysisView), total, query);
  }

  private async load(companyId: string, id: string) {
    const a = await this.db.analysis.findFirst({
      where: { id, campaign: { companyId } },
      include: {
        campaign: true,
        opportunities: { include: { evidence: true }, orderBy: { rankScore: "desc" } },
        reports: { orderBy: { version: "desc" }, take: 1 },
      },
    });
    if (!a) throw notFound("Analysis");
    return a;
  }

  /** `role` is the caller's: a member only sees a preliminary run when the tenant allows it. */
  async detail(companyId: string, role: string, id: string): Promise<AnalysisDetail> {
    const a = await this.load(companyId, id);
    if (a.preliminary && role === "member") {
      const visible = await this.settings.get("analysis.preliminaryVisibleToMembers", [
        { scope: "tenant", scopeId: companyId },
      ]);
      if (!visible) throw new AppError("forbidden", "Preliminary results are not visible to members");
    }
    const weights = await this.analysis.weightsFor(a.campaignId, companyId);
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
  }

  async diff(companyId: string, id: string, otherId: string): Promise<AnalysisDiff> {
    const [a, b] = await Promise.all([this.load(companyId, id), this.load(companyId, otherId)]);
    if (a.campaignId !== b.campaignId)
      throw new AppError("validation", "Analyses belong to different campaigns");
    const weights = await this.analysis.weightsFor(a.campaignId, companyId);
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
  }

  async opportunity(companyId: string, id: string): Promise<{ opportunity: OpportunityView }> {
    const o = await this.db.opportunity.findFirst({
      where: { id, analysis: { campaign: { companyId } } },
      include: { evidence: true, analysis: true },
    });
    if (!o) throw notFound("Opportunity");
    const weights = await this.analysis.weightsFor(o.analysis.campaignId, companyId);
    return { opportunity: opportunityView(o, weights) };
  }
}

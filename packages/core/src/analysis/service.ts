import {
  runAnalysis,
  seedStateFromHandoff,
  type AnalysisFact,
  type Logger,
  type OverrideAnchor,
} from "@aidp/ai";
import { currentTenant, tenantTransaction } from "@aidp/db";
import {
  FactSchema,
  HandoffSchema,
  OpportunityOverrideSchema,
  rankScore,
  WEIGHT_PRESETS,
  WeightsSchema,
  type Handoff,
  type OpportunityOverride,
  type ReportSection,
  type Weights,
} from "@aidp/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { TenantNotices } from "../alerts/tenant-notices.js";
import type { JobPublisher } from "../jobs/definitions.js";
import type { CallerFactory } from "../providers/caller-factory.js";
import { templateFromRow } from "../sessions/prisma-store.js";
import { PrismaPromptSource } from "../sessions/prompt-source.js";
import type { SettingsService, SettingScopeRef } from "../settings/service.js";

export interface AnalysisServiceDeps {
  db: PrismaClient;
  callers: CallerFactory;
  settings: SettingsService;
  jobs: JobPublisher;
  log: Logger;
  /** Tenant notices (D-181). Absent in tools that never mail anyone. */
  notices?: TenantNotices;
}

/**
 * Runs and stores collective analyses (spec 04, FR-15 to FR-18). Queueing is separated
 * from running so the API stays fast and the worker does the model calls.
 */
export class AnalysisService {
  constructor(private readonly deps: AnalysisServiceDeps) {}

  /** Creates a queued run and publishes the job. 409-style error when one is active. */
  async queue(
    companyId: string,
    campaignId: string,
    requestedBy: string | null,
  ): Promise<{ id: string; version: number }> {
    const { db } = this.deps;
    const campaign = await db.campaign.findFirstOrThrow({ where: { id: campaignId, companyId } });
    const active = await db.analysis.findFirst({
      where: { campaignId, status: { in: ["queued", "running"] } },
    });
    if (active) throw new AnalysisInProgressError(active.id);
    const last = await db.analysis.findFirst({
      where: { campaignId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const threshold = await this.thresholdMet(campaign.id, campaign.companyId);
    const run = await db.analysis.create({
      data: {
        companyId: campaign.companyId,
        campaignId,
        version: (last?.version ?? 0) + 1,
        status: "queued",
        preliminary: !threshold.met,
        stats: { requestedBy, thresholdMet: threshold.met, ...threshold },
      },
    });
    await this.deps.jobs.publish(
      "analysis.run",
      { analysisId: run.id, companyId },
      { singletonKey: `analysis:${campaignId}` },
    );
    return { id: run.id, version: run.version };
  }

  /** Called when a session completes: queues a run once the campaign crosses its threshold. */
  async maybeQueueForCampaign(companyId: string, campaignId: string): Promise<boolean> {
    const threshold = await this.thresholdMet(campaignId, companyId);
    if (!threshold.met) return false;
    // One notice per campaign: its key is the campaign id, so every later completion is a duplicate.
    if (this.deps.notices) {
      const campaign = await this.deps.db.campaign.findFirst({
        where: { id: campaignId, companyId },
        select: { name: true },
      });
      await this.deps.notices.campaignThreshold({
        companyId,
        campaignId,
        campaignName: campaign?.name ?? "",
        completed: threshold.completed,
        needed: threshold.needed,
      });
    }
    const existing = await this.deps.db.analysis.findFirst({
      where: { campaignId, status: { in: ["queued", "running"] } },
    });
    if (existing) return false;
    const latestDone = await this.deps.db.analysis.findFirst({
      where: { campaignId, status: "done" },
      orderBy: { version: "desc" },
    });
    // Re-run automatically only when new completed sessions arrived since the last run.
    if (latestDone && ((latestDone.stats as { completed?: number }).completed ?? 0) >= threshold.completed)
      return false;
    await this.queue(companyId, campaignId, null);
    return true;
  }

  async thresholdMet(
    campaignId: string,
    companyId: string,
  ): Promise<{ met: boolean; completed: number; invited: number; needed: number }> {
    const chain = [
      { scope: "campaign" as const, scopeId: campaignId },
      { scope: "tenant" as const, scopeId: companyId },
    ];
    const [campaign, completed, invited, values] = await Promise.all([
      this.deps.db.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
      this.deps.db.session.count({ where: { campaignId, status: "completed" } }),
      this.deps.db.invitation.count({ where: { campaignId, status: { not: "revoked" } } }),
      this.deps.settings.resolveMany(["campaign.completionThresholdPercent"], chain),
    ]);
    const percent = values["campaign.completionThresholdPercent"] as number;
    const byPercent = invited > 0 ? Math.ceil((invited * percent) / 100) : Number.POSITIVE_INFINITY;
    const needed = Math.min(campaign.completionThreshold, byPercent);
    return {
      met: completed > 0 && completed >= needed,
      completed,
      invited,
      needed: Number.isFinite(needed) ? needed : campaign.completionThreshold,
    };
  }

  /** The job body: collects facts, runs the pipeline, stores results. Idempotent per analysis id. */
  async run(analysisId: string): Promise<void> {
    const { db, log } = this.deps;
    // Background work is fenced like a request: without a tenant the policies hide the campaign
    // and the failure surfaces as an unrelated Prisma error, so say what is actually wrong.
    if (currentTenant() === null)
      throw new Error("AnalysisService.run must be called inside a tenant context (withTenant)");
    const analysis = await db.analysis.findUniqueOrThrow({
      where: { id: analysisId },
      include: { campaign: true },
    });
    if (analysis.status === "done") return;
    await db.analysis.update({
      where: { id: analysisId },
      data: { status: "running", startedAt: new Date() },
    });
    const companyId = analysis.campaign.companyId;
    try {
      const chain: SettingScopeRef[] = [
        { scope: "campaign", scopeId: analysis.campaignId },
        { scope: "tenant", scopeId: companyId },
      ];
      const values = await this.deps.settings.resolveMany(
        [
          "privacy.kAnonymity",
          "analysis.similarityThreshold",
          "analysis.reportSections",
          "analysis.language",
          "analysis.weightsPreset",
          "analysis.weights",
        ],
        chain,
      );
      const weights = resolveWeights(values["analysis.weightsPreset"] as string, values["analysis.weights"]);

      const sessions = await db.session.findMany({
        where: { campaignId: analysis.campaignId, status: "completed" },
        include: { participant: true, facts: true },
      });
      const facts: AnalysisFact[] = [];
      for (const s of sessions) {
        const fields = (s.participant?.fields ?? {}) as Record<string, string>;
        for (const f of s.facts) {
          const parsed = FactSchema.safeParse(f.payload);
          if (!parsed.success) continue;
          facts.push({
            id: f.id,
            sessionId: s.id,
            participantKey: s.participantId ?? s.id,
            role: fields.role,
            department: fields.department,
            fact: parsed.data,
          });
        }
      }
      const anchoredOverrides = await this.previousOverrides(analysis.campaignId);
      const threshold = await this.thresholdMet(analysis.campaignId, companyId);
      const caller = await this.deps.callers.forCompany(companyId);
      const result = await runAnalysis(
        { caller, prompts: new PrismaPromptSource(db), logger: log },
        {
          companyId,
          campaignId: analysis.campaignId,
          campaignName: analysis.campaign.name,
          facts,
          participation: {
            invited: threshold.invited,
            completed: threshold.completed,
            sessionsAnalyzed: sessions.length,
          },
          thresholdMet: threshold.met,
          k: values["privacy.kAnonymity"] as number,
          weights,
          similarityThreshold: values["analysis.similarityThreshold"] as number,
          language: values["analysis.language"] as string,
          sections: values["analysis.reportSections"] as ReportSection[],
          overrides: {},
          anchoredOverrides,
        },
      );

      await tenantTransaction(db, async (tx) => {
        for (const o of result.opportunities) {
          const row = await tx.opportunity.create({
            data: {
              companyId,
              analysisId,
              title: o.title,
              summary: o.summary,
              solutionClass: o.solutionClass,
              factors: o.factors,
              rationale: o.rationale,
              rankScore: o.rankScore,
              clusterKey: o.clusterKey,
              ...(o.override ? { adminOverride: o.override } : {}),
              stats: o.stats,
              dataNeeded: o.dataNeeded,
              risks: o.risks,
              whyNotAi: o.whyNotAi ?? null,
            },
          });
          if (o.evidence.length)
            await tx.opportunityEvidence.createMany({
              data: o.evidence.map((e) => ({
                companyId,
                opportunityId: row.id,
                factId: e.factId,
                snippet: e.snippet,
                anonymized: e.anonymized,
              })),
            });
        }
        await tx.report.create({
          data: {
            companyId,
            analysisId,
            version: analysis.version,
            markdown: result.report.markdown,
            sections: result.report.sections,
          },
        });
        await tx.analysis.update({
          where: { id: analysisId },
          data: {
            status: "done",
            finishedAt: new Date(),
            preliminary: !threshold.met,
            stats: {
              ...(analysis.stats as object),
              ...result.stats,
              thresholdMet: threshold.met,
              completed: threshold.completed,
              invited: threshold.invited,
              needed: threshold.needed,
            },
          },
        });
      });
      log.info("analysis done", {
        analysisId,
        opportunities: result.opportunities.length,
        clusters: result.clusters.length,
      });
      // After the commit, so nobody is told about a report that was rolled back.
      await this.deps.notices?.analysisReady({
        companyId,
        campaignId: analysis.campaignId,
        campaignName: analysis.campaign.name,
        analysisId,
        version: analysis.version,
        preliminary: !threshold.met,
      });
    } catch (err) {
      log.warn("analysis failed", { analysisId, error: err instanceof Error ? err.message : String(err) });
      await db.analysis.update({
        where: { id: analysisId },
        data: {
          status: "failed",
          finishedAt: new Date(),
          stats: { ...(analysis.stats as object), error: err instanceof Error ? err.message : String(err) },
        },
      });
      throw err;
    }
  }

  /**
   * Overrides from the latest completed run, each anchored to the fact ids of the opportunity it
   * sat on (its evidence rows, which are kept even below k). A new run re-attaches an override to
   * whichever cluster now holds those facts, so an edit survives the clusters being re-formed
   * (blueprint section 0 item 1); a cluster key alone would not.
   */
  private async previousOverrides(campaignId: string): Promise<OverrideAnchor[]> {
    const latest = await this.deps.db.analysis.findFirst({
      where: { campaignId, status: "done" },
      orderBy: { version: "desc" },
      include: {
        opportunities: {
          where: { adminOverride: { not: Prisma.DbNull } },
          include: { evidence: { select: { factId: true } } },
        },
      },
    });
    const out: OverrideAnchor[] = [];
    for (const o of latest?.opportunities ?? []) {
      const parsed = OpportunityOverrideSchema.safeParse(o.adminOverride);
      if (parsed.success) out.push({ factIds: o.evidence.map((e) => e.factId), override: parsed.data });
    }
    return out;
  }

  /** Applies an admin override and re-ranks under the campaign's current weights. */
  async override(companyId: string, opportunityId: string, override: OpportunityOverride): Promise<void> {
    const { db } = this.deps;
    const o = await this.load(companyId, opportunityId);
    const merged = OpportunityOverrideSchema.parse({
      ...(OpportunityOverrideSchema.safeParse(o.adminOverride).data ?? {}),
      ...override,
    });
    const factors = { ...(o.factors as Record<string, { score: number; rationale: string }>) };
    for (const [k, v] of Object.entries(merged.factors ?? {})) if (v) factors[k] = v;
    const weights = await this.weightsFor(o.analysis.campaignId, companyId);
    await db.opportunity.update({
      where: { id: o.id },
      data: {
        adminOverride: merged,
        ...(merged.title ? { title: merged.title } : {}),
        ...(merged.solutionClass ? { solutionClass: merged.solutionClass } : {}),
        factors: factors,
        rankScore: rankScore(factors as Parameters<typeof rankScore>[0], weights),
      },
    });
  }

  async setStatus(
    companyId: string,
    opportunityId: string,
    status: "new" | "shortlisted" | "dismissed",
  ): Promise<void> {
    const o = await this.load(companyId, opportunityId);
    if (o.status === "promoted") throw new Error("A promoted opportunity keeps its status");
    await this.deps.db.opportunity.update({ where: { id: o.id }, data: { status } });
  }

  /** Builds the hand-off and creates a requirements session owned by the promoting user (FR-18, FR-66). */
  async promote(
    companyId: string,
    opportunityId: string,
    ownerUserId: string,
  ): Promise<{ sessionId: string; handoff: Handoff }> {
    const { db } = this.deps;
    const o = await this.load(companyId, opportunityId);
    const template = await db.interviewTemplate.findFirst({
      where: { key: "requirements_discovery", status: "published", OR: [{ companyId }, { companyId: null }] },
      orderBy: [{ companyId: { sort: "desc", nulls: "last" } }, { version: "desc" }],
    });
    if (!template) throw new Error("No published requirements_discovery template");
    const stats = o.stats as { roles?: string[]; tools?: string[]; quotes?: string[] };
    const factors = o.factors as Record<string, { score: number; rationale: string }>;
    const processes = await db.fact.findMany({
      where: { id: { in: o.evidence.map((e) => e.factId) }, kind: "process" },
    });
    const handoff = HandoffSchema.parse({
      sourceOpportunityId: o.id,
      problem: o.summary,
      affectedUsers: stats.roles ?? [],
      existingProcess: processes.flatMap((p) =>
        ((p.payload as { steps?: string[] }).steps ?? []).slice(0, 8),
      ),
      tools: stats.tools ?? [],
      constraints: factors.risk?.rationale ?? "",
      expectedBenefit: factors.expected_impact?.rationale ?? "",
      evidenceQuotes: stats.quotes ?? [],
    });
    const override = OpportunityOverrideSchema.safeParse(o.adminOverride);
    const title = (override.success && override.data.title ? override.data.title : o.title || o.summary)
      .trim()
      .slice(0, 120);
    const state = seedStateFromHandoff(undefined, handoff, templateFromRow(template));
    // The owner is staff: no consent screen, the session is ready for its first turn.
    const session = await db.session.create({
      data: {
        companyId,
        templateId: template.id,
        ownerUserId,
        sourceKind: "handoff",
        handoff: handoff,
        title,
        status: "consented",
        consentedAt: new Date(),
        state: state as Prisma.InputJsonValue,
        templateVersion: template.version,
      },
    });
    await db.opportunity.update({
      where: { id: o.id },
      data: { status: "promoted", promotedSessionId: session.id },
    });
    return { sessionId: session.id, handoff };
  }

  async weightsFor(campaignId: string, companyId: string): Promise<Weights> {
    const values = await this.deps.settings.resolveMany(
      ["analysis.weightsPreset", "analysis.weights"],
      [
        { scope: "campaign", scopeId: campaignId },
        { scope: "tenant", scopeId: companyId },
      ],
    );
    return resolveWeights(values["analysis.weightsPreset"] as string, values["analysis.weights"]);
  }

  private async load(companyId: string, opportunityId: string) {
    const o = await this.deps.db.opportunity.findFirst({
      where: { id: opportunityId, analysis: { campaign: { companyId } } },
      include: { analysis: true, evidence: true },
    });
    if (!o) throw new OpportunityNotFoundError();
    return o;
  }
}

export function resolveWeights(preset: string, custom: unknown): Weights {
  if (preset === "custom") {
    const parsed = WeightsSchema.safeParse(custom);
    if (parsed.success) return parsed.data;
  }
  return WEIGHT_PRESETS[(preset in WEIGHT_PRESETS ? preset : "balanced") as keyof typeof WEIGHT_PRESETS];
}

export class AnalysisInProgressError extends Error {
  constructor(readonly analysisId: string) {
    super("An analysis is already queued or running for this campaign");
    this.name = "AnalysisInProgressError";
  }
}
export class OpportunityNotFoundError extends Error {
  constructor() {
    super("Opportunity not found");
    this.name = "OpportunityNotFoundError";
  }
}

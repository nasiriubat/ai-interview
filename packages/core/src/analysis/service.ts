import {
  factText,
  proposeSplit,
  runAnalysis,
  seedStateFromHandoff,
  type AnalysisFact,
  type ClusterEditOp,
  type Logger,
  type OverrideAnchor,
} from "@aidp/ai";
import { currentTenant, tenantTransaction } from "@aidp/db";
import {
  ClusterEditPayloadSchema,
  FactSchema,
  HandoffSchema,
  MAX_SPLIT_PARTS,
  OpportunityDraftSchema,
  OpportunityOverrideSchema,
  rankScore,
  WEIGHT_PRESETS,
  WeightsSchema,
  type Handoff,
  type OpportunityOverride,
  type SplitProposal,
  type ReportSection,
  type Weights,
} from "@aidp/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { z } from "zod";
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
      include: { campaign: { include: { template: { select: { key: true, version: true } } } } },
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
          "analysis.departmentComparison",
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
      const edits = await this.activeEdits(analysis.campaignId);
      const carried = await this.previousStatuses(analysis.campaignId);
      const trigger = analysis.stats as { trigger?: string; baseVersion?: number };
      // An edit run starts from the clustering the base run made, before its own edits (D-200).
      const seed =
        trigger.trigger === "edit"
          ? await this.editSeed(analysis.campaignId, trigger.baseVersion)
          : undefined;
      if (seed) {
        const members = new Set(seed.clusters.flatMap((c) => c.factIds));
        for (let i = facts.length - 1; i >= 0; i--) if (!members.has(facts[i]?.id ?? "")) facts.splice(i, 1);
      }
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
          edits,
          departmentComparison: values["analysis.departmentComparison"] !== false,
          provenance: {
            templateKey: analysis.campaign.template.key,
            templateVersion: analysis.campaign.template.version,
            weightsPreset: values["analysis.weightsPreset"] as string,
          },
          ...(seed ? { seed } : {}),
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
              factIds: o.factIds,
              // Shortlisted, dismissed and promoted survive a re-run for a cluster that is still
              // there (promoted only when its members are unchanged: the session was about them).
              ...carriedStatus(carried.get(o.clusterKey), o.factIds),
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
            clusters: result.baseClusters,
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

  /** Active (not undone) cluster edits of a campaign, oldest first: the order they were made in. */
  private async activeEdits(campaignId: string): Promise<ClusterEditOp[]> {
    const rows = await this.deps.db.clusterEdit.findMany({
      where: { campaignId, revokedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const out: ClusterEditOp[] = [];
    for (const r of rows) {
      const p = ClusterEditPayloadSchema.safeParse(r.payload);
      if (!p.success) continue;
      out.push(
        p.data.op === "merge"
          ? { id: r.id, op: "merge", anchors: p.data.anchors, title: p.data.title }
          : { id: r.id, op: "split", source: p.data.source, parts: p.data.parts },
      );
    }
    return out;
  }

  /** The clusters and opportunities of the run an edit run is based on. */
  private async editSeed(campaignId: string, baseVersion: number | undefined) {
    const base = await this.deps.db.analysis.findFirst({
      where: { campaignId, version: baseVersion ?? -1, status: "done" },
      include: { opportunities: true },
    });
    const raw = Array.isArray(base?.clusters) ? (base.clusters as unknown[]) : [];
    const clusters = raw.flatMap((c) => {
      const o = c as { key?: unknown; name?: unknown; summary?: unknown; factIds?: unknown };
      return typeof o.key === "string" && Array.isArray(o.factIds)
        ? [
            {
              key: o.key,
              name: typeof o.name === "string" ? o.name : "",
              summary: typeof o.summary === "string" ? o.summary : "",
              factIds: o.factIds.filter((x): x is string => typeof x === "string"),
            },
          ]
        : [];
    });
    if (!base || clusters.length === 0) throw new RerunRequiredError();
    const reuse = new Map<string, { factIds: string[]; draft: z.infer<typeof OpportunityDraftSchema> }>();
    for (const o of base.opportunities) {
      const factIds = stringList(o.factIds);
      // What the model generated is what is reused; the admin's overrides are applied again on top.
      const draft = OpportunityDraftSchema.safeParse({
        title: o.title,
        summary: o.summary,
        solutionClass: o.solutionClass,
        rationale: o.rationale,
        factors: o.factors,
        dataNeeded: o.dataNeeded,
        risks: o.risks,
        ...(o.whyNotAi ? { whyNotAi: o.whyNotAi } : {}),
      });
      if (draft.success && factIds.length > 0) reuse.set(o.clusterKey, { factIds, draft: draft.data });
    }
    return { clusters, reuse };
  }

  /** Status and promotion of each opportunity of the latest finished run, by cluster key. */
  private async previousStatuses(
    campaignId: string,
  ): Promise<Map<string, { status: string; promotedSessionId: string | null; factIds: string[] }>> {
    const latest = await this.deps.db.analysis.findFirst({
      where: { campaignId, status: "done" },
      orderBy: { version: "desc" },
      include: {
        opportunities: { select: { clusterKey: true, status: true, promotedSessionId: true, factIds: true } },
      },
    });
    return new Map(
      (latest?.opportunities ?? [])
        .filter((o) => o.status !== "new")
        .map((o) => [
          o.clusterKey,
          { status: o.status, promotedSessionId: o.promotedSessionId, factIds: stringList(o.factIds) },
        ]),
    );
  }

  /** The newest analysis of a campaign must be the one being edited, finished and editable. */
  private async editableLatest(companyId: string, analysisId: string) {
    const a = await this.deps.db.analysis.findFirst({
      where: { id: analysisId, campaign: { companyId } },
    });
    if (!a) throw new OpportunityNotFoundError();
    const newest = await this.deps.db.analysis.findFirst({
      where: { campaignId: a.campaignId },
      orderBy: { version: "desc" },
      select: { id: true, status: true },
    });
    if (newest && (newest.status === "queued" || newest.status === "running"))
      throw new AnalysisInProgressError(newest.id);
    if (newest?.id !== a.id)
      throw new ClusterEditRefusedError("stale_analysis", "Only the newest analysis can be edited");
    if (a.status !== "done")
      throw new ClusterEditRefusedError("stale_analysis", "The analysis has not finished");
    if (!Array.isArray(a.clusters) || a.clusters.length === 0) throw new RerunRequiredError();
    return a;
  }

  private async queueEditRun(
    companyId: string,
    analysis: { id: string; campaignId: string; version: number },
    requestedBy: string | null,
    editId: string,
  ): Promise<{ id: string; version: number }> {
    const { db } = this.deps;
    const threshold = await this.thresholdMet(analysis.campaignId, companyId);
    const run = await db.analysis.create({
      data: {
        companyId,
        campaignId: analysis.campaignId,
        version: analysis.version + 1,
        status: "queued",
        preliminary: !threshold.met,
        stats: {
          requestedBy,
          trigger: "edit",
          baseVersion: analysis.version,
          editId,
          thresholdMet: threshold.met,
          ...threshold,
        },
      },
    });
    await this.deps.jobs.publish(
      "analysis.run",
      { analysisId: run.id, companyId },
      { singletonKey: `analysis:${analysis.campaignId}` },
    );
    return { id: run.id, version: run.version };
  }

  private async kFor(companyId: string, campaignId: string): Promise<number> {
    const values = await this.deps.settings.resolveMany(
      ["privacy.kAnonymity"],
      [
        { scope: "campaign", scopeId: campaignId },
        { scope: "tenant", scopeId: companyId },
      ],
    );
    return values["privacy.kAnonymity"] as number;
  }

  /**
   * Merges opportunities of the newest analysis (FR-18). The edit is stored against each cluster's
   * fact ids, so a later full run applies it to whatever clusters it finds; the new version is made
   * by an edit run that costs a model call only for the merged cluster.
   */
  async merge(
    companyId: string,
    analysisId: string,
    opportunityIds: string[],
    title: string | undefined,
    userId: string | null,
  ): Promise<{ analysis: { id: string; version: number }; editId: string }> {
    const ids = [...new Set(opportunityIds)];
    if (ids.length < 2)
      throw new ClusterEditRefusedError("validation", "Pick at least two different opportunities");
    const a = await this.editableLatest(companyId, analysisId);
    const opps = await this.deps.db.opportunity.findMany({ where: { id: { in: ids }, analysisId: a.id } });
    if (opps.length !== ids.length) throw new OpportunityNotFoundError();
    if (opps.some((o) => o.status === "promoted"))
      throw new ClusterEditRefusedError(
        "promoted",
        "A promoted opportunity has a requirements session and cannot be merged",
      );
    const anchors = opps.map((o) => stringList(o.factIds));
    if (anchors.some((x) => x.length === 0)) throw new RerunRequiredError();
    const edit = await this.deps.db.clusterEdit.create({
      data: {
        companyId,
        campaignId: a.campaignId,
        op: "merge",
        payload: { op: "merge", anchors, ...(title ? { title } : {}) },
        createdBy: userId,
      },
    });
    const analysis = await this.queueEditRun(companyId, a, userId, edit.id);
    return { analysis, editId: edit.id };
  }

  /** An opportunity's facts for the split dialog: text only, no person, role or department. */
  async splitProposal(companyId: string, opportunityId: string): Promise<SplitProposal> {
    const o = await this.load(companyId, opportunityId);
    const factIds = await this.splittableFacts(companyId, o);
    const rows = await this.deps.db.fact.findMany({ where: { id: { in: factIds }, companyId } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const items = factIds.flatMap((id) => {
      const parsed = FactSchema.safeParse(byId.get(id)?.payload);
      return parsed.success ? [{ id, text: factText(parsed.data, { quotes: false }) }] : [];
    });
    if (items.length < 2)
      throw new ClusterEditRefusedError("too_small", "A cluster of one fact cannot be split");
    const run = await this.deps.settings.resolveMany(
      ["analysis.similarityThreshold"],
      [
        { scope: "campaign", scopeId: o.analysis.campaignId },
        { scope: "tenant", scopeId: companyId },
      ],
    );
    const parts = await proposeSplit(
      items.map((i) => i.text),
      Math.min(run["analysis.similarityThreshold"] as number, 0.08),
    );
    return {
      facts: items.map((i, n) => ({ ...i, part: parts[n] ?? 0 })),
      parts: Math.min(MAX_SPLIT_PARTS, Math.max(2, new Set(parts).size)),
    };
  }

  /** The member facts of an opportunity, after the checks every split needs. */
  private async splittableFacts(
    companyId: string,
    o: { status: string; factIds: unknown; stats: unknown; analysis: { campaignId: string } },
  ): Promise<string[]> {
    if (o.status === "promoted")
      throw new ClusterEditRefusedError(
        "promoted",
        "A promoted opportunity has a requirements session and cannot be split",
      );
    const factIds = stringList(o.factIds);
    if (factIds.length === 0) throw new RerunRequiredError();
    const k = await this.kFor(companyId, o.analysis.campaignId);
    const participants = (o.stats as { participants?: number }).participants ?? 0;
    // Below k the cluster's facts are not shown to the person splitting it, so it is not split by
    // reading them (D-201).
    if (participants < k)
      throw new ClusterEditRefusedError(
        "below_k",
        `Fewer than ${k} participants are behind this opportunity, so its facts are not shown`,
      );
    return factIds;
  }

  /** Splits one opportunity into the parts given (a partition of its fact ids). */
  async split(
    companyId: string,
    opportunityId: string,
    parts: string[][],
    userId: string | null,
  ): Promise<{ analysis: { id: string; version: number }; editId: string }> {
    const o = await this.load(companyId, opportunityId);
    const a = await this.editableLatest(companyId, o.analysisId);
    const all = await this.splittableFacts(companyId, o);
    const flat = parts.flat();
    const known = new Set(all);
    if (new Set(flat).size !== flat.length)
      throw new ClusterEditRefusedError("validation", "A fact can be in one part only");
    if (flat.length !== all.length || flat.some((id) => !known.has(id)))
      throw new ClusterEditRefusedError(
        "validation",
        "Every fact of the opportunity must be placed in exactly one part",
      );
    const edit = await this.deps.db.clusterEdit.create({
      data: {
        companyId,
        campaignId: a.campaignId,
        op: "split",
        payload: { op: "split", source: all, parts },
        createdBy: userId,
      },
    });
    const analysis = await this.queueEditRun(companyId, a, userId, edit.id);
    return { analysis, editId: edit.id };
  }

  /** The campaign's cluster edits, newest first, with whether each is still in force. */
  async listEdits(companyId: string, campaignId: string): Promise<ClusterEditSummary[]> {
    const rows = await this.deps.db.clusterEdit.findMany({
      where: { campaignId, companyId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => {
      const p = ClusterEditPayloadSchema.safeParse(r.payload);
      return {
        id: r.id,
        op: r.op,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        revokedAt: r.revokedAt,
        ...(p.success && p.data.op === "merge"
          ? { clusters: p.data.anchors.length, ...(p.data.title ? { title: p.data.title } : {}) }
          : {}),
        ...(p.success && p.data.op === "split" ? { parts: p.data.parts.length } : {}),
      };
    });
  }

  /** Undoes an edit and re-derives the clusters without it: one more edit run. */
  async undoEdit(
    companyId: string,
    campaignId: string,
    editId: string,
    userId: string | null,
  ): Promise<{ analysis: { id: string; version: number } }> {
    const edit = await this.deps.db.clusterEdit.findFirst({ where: { id: editId, campaignId, companyId } });
    if (!edit) throw new OpportunityNotFoundError();
    if (edit.revokedAt) throw new ClusterEditRefusedError("already_undone", "This edit was already undone");
    const newest = await this.deps.db.analysis.findFirst({
      where: { campaignId },
      orderBy: { version: "desc" },
    });
    if (!newest) throw new OpportunityNotFoundError();
    const a = await this.editableLatest(companyId, newest.id);
    await this.deps.db.clusterEdit.update({ where: { id: edit.id }, data: { revokedAt: new Date() } });
    const analysis = await this.queueEditRun(companyId, a, userId, edit.id);
    return { analysis };
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
        ...(merged.summary ? { summary: merged.summary } : {}),
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
/** One row of the edit history: what was done, by whom, and whether it is still in force. */
export interface ClusterEditSummary {
  id: string;
  op: string;
  createdBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  /** Merge: how many clusters it joined. */
  clusters?: number;
  title?: string;
  /** Split: how many parts it made. */
  parts?: number;
}

/** The analysis predates cluster edits (it has no stored clusters) and has to be run again first. */
export class RerunRequiredError extends Error {
  constructor() {
    super("Run the analysis again to enable editing");
    this.name = "RerunRequiredError";
  }
}
/** A merge, split or undo that cannot be done; `reason` says why in one word. */
export class ClusterEditRefusedError extends Error {
  constructor(
    readonly reason:
      "stale_analysis" | "below_k" | "promoted" | "validation" | "too_small" | "already_undone",
    message: string,
  ) {
    super(message);
    this.name = "ClusterEditRefusedError";
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function carriedStatus(
  prior: { status: string; promotedSessionId: string | null; factIds: string[] } | undefined,
  factIds: string[],
): { status?: string; promotedSessionId?: string | null } {
  if (!prior) return {};
  if (prior.status === "promoted") {
    const same = prior.factIds.length === factIds.length && prior.factIds.every((id) => factIds.includes(id));
    return same ? { status: "promoted", promotedSessionId: prior.promotedSessionId } : {};
  }
  return { status: prior.status };
}

export class OpportunityNotFoundError extends Error {
  constructor() {
    super("Opportunity not found");
    this.name = "OpportunityNotFoundError";
  }
}

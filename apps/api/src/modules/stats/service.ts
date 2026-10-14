import { tenantTransaction } from "@aidp/db";
import type {
  StatsAi,
  StatsDiscovery,
  StatsHealth,
  StatsParticipation,
  StatsRange,
  StatsRequirements,
} from "@aidp/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import * as segments from "./segments.js";

/** The purposes a participant waits on: the ones the first-token SLO is read from (NFR-01). */
export const INTERACTIVE_PURPOSES = ["interview_turn", "spec_turn"] as const;

export interface Dashboard {
  participation: { campaigns: Record<string, number>; sessions: Record<string, number>; invited: number };
  /** Opportunities by class, where AI is not the answer, and the ten highest ranked (spec 07). */
  discovery: StatsDiscovery;
  ai: {
    month: {
      costCents: number;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cacheHitRate: number;
      avgLatencyMs: number;
      byStatus: Record<string, number>;
      /** Time to the first streamed token of an interview turn, this month; null when none was measured (D-222). */
      firstTokenP50Ms: number | null;
      firstTokenP95Ms: number | null;
      /** Minutes of audio sent to transcription and characters sent to speech, this month (D-220). */
      audioMinutes: number;
      ttsCharacters: number;
      /** Rows whose usage is our estimate, as a share of the month's cost (D-221). */
      estimatedCostShare: number;
      voice: {
        sessions: number;
        /** p95 across sessions of each session's average question-to-first-word time. */
        firstWordP95Ms: number | null;
        interruptionsPerSession: number | null;
        streamFallbacks: number;
      };
    };
    budget: { limitCents: number; period: string } | null;
  };
}

export interface SpendReport {
  rows: SpendRow[];
  budget: { limitCents: number | null; spentCents: number };
}

export type SpendGroupBy = "day" | "purpose" | "model" | "campaign" | "provider" | "status";

export interface SpendRow {
  key: string;
  /** A provider's name for `groupBy=provider`; absent otherwise. */
  label?: string;
  costCents: number;
  calls: number;
  tokens: number;
  audioSeconds: number;
  ttsCharacters: number;
  /** Cost that is our estimate rather than the provider's report (D-221). */
  estimatedCents: number;
}

/** One budget line and where spend against it stands (D-224). */
export interface BudgetLineSpend {
  id: string;
  scope: "tenant" | "campaign" | "session";
  scopeId: string;
  /** The campaign's name for a campaign budget; null otherwise. */
  name: string | null;
  period: "month" | "total";
  limitCents: number;
  spentCents: number;
  fraction: number;
  state: "ok" | "warning" | "blocked";
}

const count = (rows: { status: string; _count: { _all: number } }[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.status, r._count._all]));

/** Dashboard numbers for one tenant (spec 07). Cheap aggregates only. */
export class StatsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly deps: Omit<segments.SegmentDeps, "db">,
  ) {}

  private get seg(): segments.SegmentDeps {
    return { db: this.db, ...this.deps };
  }

  participation(companyId: string, range: StatsRange): Promise<StatsParticipation> {
    return segments.participation(this.seg, companyId, range);
  }

  discovery(companyId: string, role: string, range: StatsRange): Promise<StatsDiscovery> {
    return segments.discovery(this.seg, companyId, role, range);
  }

  requirements(
    companyId: string,
    who: { role: string; userId: string },
    range: StatsRange,
  ): Promise<StatsRequirements> {
    return segments.requirements(this.seg, companyId, who, range);
  }

  ai(companyId: string, range: StatsRange): Promise<StatsAi> {
    return segments.ai(this.seg, companyId, range);
  }

  health(companyId: string): Promise<StatsHealth> {
    return segments.health(this.seg, companyId);
  }

  async dashboard(companyId: string, role = "admin"): Promise<Dashboard> {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [campaigns, sessionsByStatus, invited, spend, calls, budget] = await Promise.all([
      this.db.campaign.groupBy({ by: ["status"], where: { companyId }, _count: { _all: true } }),
      // Interviews only: a requirements project is not a participant, and counting it here made the
      // funnel's "started" larger than the people who were ever invited.
      this.db.session.groupBy({
        by: ["status"],
        where: { companyId, sourceKind: "campaign" },
        _count: { _all: true },
      }),
      this.db.invitation.count({ where: { campaign: { companyId }, status: { not: "revoked" } } }),
      this.db.llmCall.aggregate({
        where: { companyId, createdAt: { gte: monthStart } },
        _sum: { costCents: true, inputTokens: true, outputTokens: true, cacheReadTokens: true },
        _count: { _all: true },
        _avg: { latencyMs: true },
      }),
      this.db.llmCall.groupBy({
        by: ["status"],
        where: { companyId, createdAt: { gte: monthStart } },
        _count: { _all: true },
      }),
      this.db.budget.findFirst({ where: { scope: "tenant", scopeId: companyId } }),
    ]);
    const [latency, voice, media, estimated] = await Promise.all([
      this.firstTokenPercentiles(companyId, monthStart),
      this.voiceSignals(companyId, monthStart),
      this.db.llmCall.aggregate({
        where: { companyId, createdAt: { gte: monthStart } },
        _sum: { audioSeconds: true, ttsCharacters: true },
      }),
      this.db.llmCall.aggregate({
        where: { companyId, createdAt: { gte: monthStart }, estimated: true },
        _sum: { costCents: true },
      }),
    ]);
    const totalInput = (spend._sum.inputTokens ?? 0) + (spend._sum.cacheReadTokens ?? 0);
    return {
      participation: { campaigns: count(campaigns), sessions: count(sessionsByStatus), invited },
      discovery: await this.discovery(companyId, role, {}),
      ai: {
        month: {
          costCents: spend._sum.costCents ?? 0,
          calls: spend._count._all,
          inputTokens: totalInput,
          outputTokens: spend._sum.outputTokens ?? 0,
          cacheHitRate: totalInput ? (spend._sum.cacheReadTokens ?? 0) / totalInput : 0,
          avgLatencyMs: spend._avg.latencyMs ?? 0,
          byStatus: count(calls),
          firstTokenP50Ms: latency.p50,
          firstTokenP95Ms: latency.p95,
          audioMinutes: Math.round(((media._sum.audioSeconds ?? 0) / 60) * 100) / 100,
          ttsCharacters: media._sum.ttsCharacters ?? 0,
          estimatedCostShare: spend._sum.costCents
            ? (estimated._sum.costCents ?? 0) / spend._sum.costCents
            : 0,
          voice,
        },
        budget: budget ? { limitCents: budget.limitCents, period: budget.period } : null,
      },
    };
  }

  /**
   * p50 and p95 of `firstTokenMs` for the interactive purposes since `since`. Computed in the
   * database: pulling a month of rows to sort them in memory is what a percentile is not for.
   */
  async firstTokenPercentiles(
    companyId: string,
    since: Date,
  ): Promise<{ p50: number | null; p95: number | null }> {
    // In a transaction that carries the tenant: a raw statement outside one is not paired with the
    // setting that row-level security reads.
    const rows = await tenantTransaction(
      this.db,
      (tx) =>
        tx.$queryRaw<{ p50: number | null; p95: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY "firstTokenMs")::float8 AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY "firstTokenMs")::float8 AS p95
        FROM "LlmCall"
       WHERE "companyId" = ${companyId}
         AND "createdAt" >= ${since}
         AND "firstTokenMs" IS NOT NULL
         AND purpose IN (${Prisma.join([...INTERACTIVE_PURPOSES])})`,
    );
    const r = rows[0];
    const round = (v: number | null | undefined): number | null =>
      v === null || v === undefined ? null : Math.round(v);
    return { p50: round(r?.p50), p95: round(r?.p95) };
  }

  /** Live voice signals from the per-call `voice.live` events (spec 09). */
  private async voiceSignals(companyId: string, since: Date): Promise<Dashboard["ai"]["month"]["voice"]> {
    const rows = await tenantTransaction(
      this.db,
      (tx) =>
        tx.$queryRaw<
          { sessions: bigint; p95: number | null; interruptions: number | null; fallbacks: bigint | null }[]
        >`
      SELECT count(*) AS sessions,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY (payload->>'avgFirstWordMs')::float8)
               FILTER (WHERE payload->>'avgFirstWordMs' IS NOT NULL)::float8 AS p95,
             avg((payload->>'interruptions')::float8)::float8 AS interruptions,
             sum((payload->>'streamFallbacks')::bigint) AS fallbacks
        FROM "SessionEvent"
       WHERE "companyId" = ${companyId} AND type = 'voice.live' AND "createdAt" >= ${since}`,
    );
    const r = rows[0];
    const sessions = Number(r?.sessions ?? 0);
    return {
      sessions,
      firstWordP95Ms: r?.p95 === null || r?.p95 === undefined ? null : Math.round(r.p95),
      interruptionsPerSession:
        sessions === 0 || r?.interruptions === null || r?.interruptions === undefined
          ? null
          : Math.round(r.interruptions * 100) / 100,
      streamFallbacks: Number(r?.fallbacks ?? 0),
    };
  }

  /**
   * Every budget line of the tenant with what has been spent against it (D-224): the tenant's own,
   * each campaign's, each session's. `state` is `blocked` at the limit and `warning` from the
   * warn fraction; `fraction` can exceed 1 when spend arrived before the limit was lowered.
   */
  async budgets(companyId: string, warnFraction: number, now: Date = new Date()): Promise<BudgetLineSpend[]> {
    const rows = await this.db.budget.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } });
    if (rows.length === 0) return [];
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const campaignIds = rows.filter((r) => r.scope === "campaign").map((r) => r.scopeId);
    const campaigns = campaignIds.length
      ? await this.db.campaign.findMany({
          where: { companyId, id: { in: campaignIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(campaigns.map((c) => [c.id, c.name]));
    const out: BudgetLineSpend[] = [];
    for (const r of rows) {
      const scope: Prisma.LlmCallWhereInput =
        r.scope === "tenant"
          ? { companyId }
          : r.scope === "campaign"
            ? { companyId, campaignId: r.scopeId }
            : { companyId, sessionId: r.scopeId };
      const agg = await this.db.llmCall.aggregate({
        _sum: { costCents: true },
        where: { ...scope, ...(r.period === "month" ? { createdAt: { gte: monthStart } } : {}) },
      });
      const spent = agg._sum.costCents ?? 0;
      const fraction = r.limitCents > 0 ? spent / r.limitCents : spent > 0 ? 1 : 0;
      out.push({
        id: r.id,
        scope: r.scope as BudgetLineSpend["scope"],
        scopeId: r.scopeId,
        name: r.scope === "campaign" ? (names.get(r.scopeId) ?? null) : null,
        period: r.period as BudgetLineSpend["period"],
        limitCents: r.limitCents,
        spentCents: spent,
        fraction,
        state: fraction >= 1 ? "blocked" : fraction >= warnFraction ? "warning" : "ok",
      });
    }
    return out;
  }

  async spend(
    companyId: string,
    query: { from?: Date | undefined; to?: Date | undefined; groupBy: SpendGroupBy },
  ): Promise<SpendReport> {
    const from = query.from ?? new Date(Date.now() - 30 * 86400_000);
    const to = query.to ?? new Date();
    const rows = await this.db.llmCall.findMany({
      where: { companyId, createdAt: { gte: from, lte: to } },
      select: {
        createdAt: true,
        purpose: true,
        model: true,
        campaignId: true,
        costCents: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        providerId: true,
        status: true,
        audioSeconds: true,
        ttsCharacters: true,
        estimated: true,
      },
    });
    const providerNames =
      query.groupBy === "provider"
        ? new Map(
            (
              await this.db.provider.findMany({
                where: { id: { in: [...new Set(rows.map((r) => r.providerId))] } },
                select: { id: true, name: true },
              })
            ).map((p) => [p.id, p.name]),
          )
        : new Map<string, string>();
    const keyOf = (r: (typeof rows)[number]): string =>
      query.groupBy === "day"
        ? r.createdAt.toISOString().slice(0, 10)
        : query.groupBy === "purpose"
          ? r.purpose
          : query.groupBy === "model"
            ? r.model
            : query.groupBy === "provider"
              ? r.providerId
              : query.groupBy === "status"
                ? r.status
                : (r.campaignId ?? "none");
    const grouped = new Map<string, SpendRow>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = grouped.get(k) ?? {
        key: k,
        ...(query.groupBy === "provider" ? { label: providerNames.get(k) ?? k } : {}),
        costCents: 0,
        calls: 0,
        tokens: 0,
        audioSeconds: 0,
        ttsCharacters: 0,
        estimatedCents: 0,
      };
      g.costCents += r.costCents;
      g.calls += 1;
      g.tokens += r.inputTokens + r.cacheReadTokens + r.outputTokens;
      g.audioSeconds += r.audioSeconds;
      g.ttsCharacters += r.ttsCharacters;
      if (r.estimated) g.estimatedCents += r.costCents;
      grouped.set(k, g);
    }
    const budget = await this.db.budget.findFirst({ where: { scope: "tenant", scopeId: companyId } });
    const monthStart = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    const spent = await this.db.llmCall.aggregate({
      where: { companyId, createdAt: { gte: monthStart } },
      _sum: { costCents: true },
    });
    return {
      rows: [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key)),
      budget: { limitCents: budget?.limitCents ?? null, spentCents: spent._sum.costCents ?? 0 },
    };
  }
}

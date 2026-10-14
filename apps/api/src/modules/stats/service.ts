import type {
  StatsAi,
  StatsDiscovery,
  StatsHealth,
  StatsParticipation,
  StatsRange,
  StatsRequirements,
} from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import * as segments from "./segments.js";

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
    };
    budget: { limitCents: number; period: string } | null;
  };
}

export interface SpendReport {
  rows: SpendRow[];
  budget: { limitCents: number | null; spentCents: number };
}

export type SpendGroupBy = "day" | "purpose" | "model" | "campaign";

export interface SpendRow {
  key: string;
  costCents: number;
  calls: number;
  tokens: number;
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
        },
        budget: budget ? { limitCents: budget.limitCents, period: budget.period } : null,
      },
    };
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
      },
    });
    const keyOf = (r: (typeof rows)[number]): string =>
      query.groupBy === "day"
        ? r.createdAt.toISOString().slice(0, 10)
        : query.groupBy === "purpose"
          ? r.purpose
          : query.groupBy === "model"
            ? r.model
            : (r.campaignId ?? "none");
    const grouped = new Map<string, SpendRow>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = grouped.get(k) ?? { key: k, costCents: 0, calls: 0, tokens: 0 };
      g.costCents += r.costCents;
      g.calls += 1;
      g.tokens += r.inputTokens + r.cacheReadTokens + r.outputTokens;
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

import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";

/** Dashboard numbers (spec 07). Cheap aggregates only; heavier analytics come with phase 5. */
export async function statsRoutes(app: App, ctx: AppContext): Promise<void> {
  app.get("/stats", { preHandler: requireStaff() }, async (req) => {
    const companyId = req.companyId;
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [campaigns, sessionsByStatus, invited, spend, calls, budget] = await Promise.all([
      ctx.db.campaign.groupBy({ by: ["status"], where: { companyId }, _count: { _all: true } }),
      ctx.db.session.groupBy({ by: ["status"], where: { companyId }, _count: { _all: true } }),
      ctx.db.invitation.count({ where: { campaign: { companyId } } }),
      ctx.db.llmCall.aggregate({
        where: { companyId, createdAt: { gte: monthStart } },
        _sum: { costCents: true, inputTokens: true, outputTokens: true, cacheReadTokens: true },
        _count: { _all: true },
        _avg: { latencyMs: true },
      }),
      ctx.db.llmCall.groupBy({
        by: ["status"],
        where: { companyId, createdAt: { gte: monthStart } },
        _count: { _all: true },
      }),
      ctx.db.budget.findFirst({ where: { scope: "tenant", scopeId: companyId } }),
    ]);
    const count = (rows: { status: string; _count: { _all: number } }[]) =>
      Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
    const totalInput = (spend._sum.inputTokens ?? 0) + (spend._sum.cacheReadTokens ?? 0);
    return {
      participation: { campaigns: count(campaigns), sessions: count(sessionsByStatus), invited },
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
  });

  app.get(
    "/spend",
    {
      preHandler: requireStaff(),
      schema: {
        querystring: z.object({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          groupBy: z.enum(["day", "purpose", "model", "campaign"]).default("day"),
        }),
      },
    },
    async (req) => {
      const from = req.query.from ?? new Date(Date.now() - 30 * 86400_000);
      const to = req.query.to ?? new Date();
      const rows = await ctx.db.llmCall.findMany({
        where: { companyId: req.companyId, createdAt: { gte: from, lte: to } },
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
        req.query.groupBy === "day"
          ? r.createdAt.toISOString().slice(0, 10)
          : req.query.groupBy === "purpose"
            ? r.purpose
            : req.query.groupBy === "model"
              ? r.model
              : (r.campaignId ?? "none");
      const grouped = new Map<string, { key: string; costCents: number; calls: number; tokens: number }>();
      for (const r of rows) {
        const k = keyOf(r);
        const g = grouped.get(k) ?? { key: k, costCents: 0, calls: 0, tokens: 0 };
        g.costCents += r.costCents;
        g.calls += 1;
        g.tokens += r.inputTokens + r.cacheReadTokens + r.outputTokens;
        grouped.set(k, g);
      }
      const budget = await ctx.db.budget.findFirst({ where: { scope: "tenant", scopeId: req.companyId } });
      const monthStart = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
      const spent = await ctx.db.llmCall.aggregate({
        where: { companyId: req.companyId, createdAt: { gte: monthStart } },
        _sum: { costCents: true },
      });
      return {
        rows: [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key)),
        budget: { limitCents: budget?.limitCents ?? null, spentCents: spent._sum.costCents ?? 0 },
      };
    },
  );
}

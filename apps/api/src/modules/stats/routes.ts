import { MONTH, statementsToCsv } from "@aidp/core";
import { StatsRangeSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { notFound } from "../../lib/errors.js";

const Month = z.string().regex(MONTH, "Expected a month as yyyy-mm");

/**
 * Dashboard numbers (spec 07, D-204 to D-206). `/stats` keeps its shape and gains `discovery`;
 * the segments are served separately so one slow query does not hold the page. Every segment takes
 * `from`, `to` and `campaignId`, and is cacheable by the browser for half a minute.
 */
export async function statsRoutes(app: App, ctx: RouteContext): Promise<void> {
  const stats = ctx.services.stats;
  const cache = { "cache-control": "private, max-age=30" };
  const segment = { ...guard.staff(), schema: { querystring: StatsRangeSchema } };

  app.get("/stats", { ...guard.staff() }, async (req) => stats.dashboard(req.companyId, staff(req).role));

  app.get("/stats/participation", segment, async (req, reply) => {
    void reply.headers(cache);
    return stats.participation(req.companyId, req.query);
  });

  app.get("/stats/discovery", segment, async (req, reply) => {
    void reply.headers(cache);
    return stats.discovery(req.companyId, staff(req).role, req.query);
  });

  app.get("/stats/requirements", segment, async (req, reply) => {
    void reply.headers(cache);
    const p = staff(req);
    return stats.requirements(req.companyId, { role: p.role, userId: p.userId }, req.query);
  });

  app.get("/stats/ai", segment, async (req, reply) => {
    void reply.headers(cache);
    return stats.ai(req.companyId, req.query);
  });

  // Queue depth is the platform's, not the organization's, so it is for the people who run things.
  app.get("/stats/health", { ...guard.admin() }, async (req, reply) => {
    void reply.headers(cache);
    return stats.health(req.companyId);
  });

  app.get(
    "/spend",
    {
      ...guard.staff(),
      schema: {
        querystring: z.object({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          groupBy: z.enum(["day", "purpose", "model", "campaign", "provider", "status"]).default("day"),
        }),
      },
    },
    async (req) => stats.spend(req.companyId, req.query),
  );

  /**
   * Spend against every budget line of the tenant: its own, each campaign's, each session's
   * (D-224). The dashboard's budget panel reads this instead of the tenant line alone.
   */
  app.get("/spend/budgets", { ...guard.staff() }, async (req) => {
    const warn = await ctx.settings.get("cost.warnFraction", [{ scope: "tenant", scopeId: req.companyId }]);
    return { budgets: await ctx.services.stats.budgets(req.companyId, warn) };
  });

  // Monthly statements (D-224): frozen on the 1st by the `billing.statement` job, read here.
  app.get("/spend/statements", { ...guard.admin() }, async (req) => ({
    statements: await ctx.statements.list(req.companyId),
  }));

  app.get(
    "/spend/statements/:month",
    {
      ...guard.admin(),
      schema: {
        params: z.object({ month: Month }),
        querystring: z.object({ format: z.enum(["json", "csv"]).default("json") }),
      },
    },
    async (req, reply) => {
      const statement = await ctx.statements.get(req.companyId, req.params.month);
      if (!statement) throw notFound("Statement");
      if (req.query.format === "csv") {
        return reply
          .header("content-type", "text/csv; charset=utf-8")
          .header("content-disposition", `attachment; filename="statement-${req.params.month}.csv"`)
          .send(statementsToCsv([statement]));
      }
      return { statement };
    },
  );
}

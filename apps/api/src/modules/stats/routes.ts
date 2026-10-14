import { MONTH, statementsToCsv } from "@aidp/core";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import type { RouteContext } from "../../context.js";
import { notFound } from "../../lib/errors.js";

const Month = z.string().regex(MONTH, "Expected a month as yyyy-mm");

/** Dashboard numbers (spec 07). Cheap aggregates only; heavier analytics come with phase 5. */
export async function statsRoutes(app: App, ctx: RouteContext): Promise<void> {
  app.get("/stats", { ...guard.staff() }, async (req) => ctx.services.stats.dashboard(req.companyId));

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
    async (req) => ctx.services.stats.spend(req.companyId, req.query),
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

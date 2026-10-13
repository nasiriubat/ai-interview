import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import type { RouteContext } from "../../context.js";

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
          groupBy: z.enum(["day", "purpose", "model", "campaign"]).default("day"),
        }),
      },
    },
    async (req) => ctx.services.stats.spend(req.companyId, req.query),
  );
}

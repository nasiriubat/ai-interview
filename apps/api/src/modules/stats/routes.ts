import { StatsRangeSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";

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
          groupBy: z.enum(["day", "purpose", "model", "campaign"]).default("day"),
        }),
      },
    },
    async (req) => stats.spend(req.companyId, req.query),
  );
}

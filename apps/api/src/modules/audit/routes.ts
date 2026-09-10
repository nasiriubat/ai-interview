import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";

export async function auditRoutes(app: App, ctx: AppContext): Promise<void> {
  app.get(
    "/audit",
    {
      preHandler: requireStaff("admin"),
      schema: {
        querystring: z.object({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
    },
    async (req) => ({
      entries: await ctx.db.auditLog.findMany({
        where: {
          companyId: req.companyId,
          createdAt: {
            ...(req.query.from ? { gte: req.query.from } : {}),
            ...(req.query.to ? { lte: req.query.to } : {}),
          },
        },
        orderBy: { createdAt: "desc" },
        take: req.query.limit,
      }),
    }),
  );
}

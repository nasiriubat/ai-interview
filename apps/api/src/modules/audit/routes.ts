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
    async (req) => {
      const entries = await ctx.db.auditLog.findMany({
        where: {
          companyId: req.companyId,
          createdAt: {
            ...(req.query.from ? { gte: req.query.from } : {}),
            ...(req.query.to ? { lte: req.query.to } : {}),
          },
        },
        orderBy: { createdAt: "desc" },
        take: req.query.limit,
      });
      // AuditLog holds only the actor's id; the log is unreadable without the address behind it.
      const actorIds = [...new Set(entries.map((e) => e.actorId).filter((id): id is string => id !== null))];
      const actors = actorIds.length
        ? await ctx.db.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, email: true },
          })
        : [];
      const emailOf = new Map(actors.map((a) => [a.id, a.email]));
      return {
        entries: entries.map((e) => ({
          ...e,
          actorEmail: e.actorId === null ? null : (emailOf.get(e.actorId) ?? null),
        })),
      };
    },
  );
}

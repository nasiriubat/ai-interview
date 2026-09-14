import { tenantBatch } from "@aidp/db";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { PageQuery } from "../../lib/pagination.js";

export async function auditRoutes(app: App, ctx: AppContext): Promise<void> {
  app.get(
    "/audit",
    {
      preHandler: requireStaff("admin"),
      schema: {
        querystring: PageQuery.extend({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
      },
    },
    async (req) => {
      const where = {
        companyId: req.companyId,
        createdAt: {
          ...(req.query.from ? { gte: req.query.from } : {}),
          ...(req.query.to ? { lte: req.query.to } : {}),
        },
      };
      const [entries, total] = await tenantBatch(ctx.db, [
        ctx.db.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: req.query.limit,
          skip: req.query.offset,
        }),
        ctx.db.auditLog.count({ where }),
      ]);
      // AuditLog holds only the actor's id; the log is unreadable without the address behind it.
      const actorIds = [...new Set(entries.map((e) => e.actorId).filter((id): id is string => id !== null))];
      const actors = actorIds.length
        ? await ctx.db.user.findMany({
            // Scoped like every other tenant-owned read: an operator acting on this tenant stays
            // an opaque id here rather than exposing an address from another company.
            where: { id: { in: actorIds }, companyId: req.companyId },
            select: { id: true, email: true },
          })
        : [];
      const emailOf = new Map(actors.map((a) => [a.id, a.email]));
      return {
        entries: entries.map((e) => ({
          ...e,
          actorEmail: e.actorId === null ? null : (emailOf.get(e.actorId) ?? null),
        })),
        total,
        limit: req.query.limit,
        offset: req.query.offset,
      };
    },
  );
}

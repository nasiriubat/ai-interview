import { tenantBatch } from "@aidp/db";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import type { AppContext } from "../../context.js";
import { AppError } from "../../lib/errors.js";
import { contains, escapeLike, listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";

/** An ISO date (`2026-09-21`) or an ISO date-time with `Z` or an offset. */
const IsoInstant = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

/**
 * `/audit` (D-79). `q` matches the action, the target id exactly, or the actor's email or name.
 * `action` is one exact action (`campaign.create`) or, ending in a dot, a family (`campaign.`).
 * `from` is inclusive; `to` is inclusive, and a bare date means the whole of that day (UTC).
 */
export const AuditList = listSpec({
  sort: { createdAt: "desc", action: "asc" },
  defaultSort: "createdAt",
  filters: {
    action: z
      .string()
      .regex(
        /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/,
        "An action such as campaign.create, or a family such as campaign.",
      )
      .max(100)
      .optional(),
    targetType: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .max(50)
      .optional(),
    from: IsoInstant.optional(),
    to: IsoInstant.optional(),
  },
});

const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The createdAt window, or a 400 when it runs backwards. */
function createdWindow(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  const gte = from ? new Date(isDateOnly(from) ? `${from}T00:00:00Z` : from) : undefined;
  const end = to
    ? isDateOnly(to)
      ? { lt: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000) }
      : { lte: new Date(to) }
    : {};
  const upper = "lt" in end ? end.lt : "lte" in end ? end.lte : undefined;
  if (gte && upper && gte.getTime() > upper.getTime())
    throw new AppError("validation", "`from` is after `to`");
  return { ...(gte ? { gte } : {}), ...end };
}

export async function auditRoutes(app: App, ctx: AppContext): Promise<void> {
  app.get("/audit", { ...guard.admin(), schema: { querystring: listQuery(AuditList) } }, async (req) => {
    const q = searchTerm(req.query.q);
    const action = req.query.action;
    // The log holds actor ids; a search by address resolves them inside this tenant only.
    const actorIds = q
      ? (
          await ctx.db.user.findMany({
            where: { companyId: req.companyId, OR: [{ email: contains(q) }, { name: contains(q) }] },
            select: { id: true },
            take: 500,
          })
        ).map((u) => u.id)
      : [];
    const createdAt = createdWindow(req.query.from, req.query.to);
    const where: Prisma.AuditLogWhereInput = {
      companyId: req.companyId,
      ...(createdAt ? { createdAt } : {}),
      ...(action ? { action: action.endsWith(".") ? { startsWith: escapeLike(action) } : action } : {}),
      ...(req.query.targetType ? { targetType: req.query.targetType } : {}),
      ...(q
        ? {
            OR: [
              { action: contains(q) },
              { targetId: q },
              ...(actorIds.length ? [{ actorId: { in: actorIds } }] : []),
            ],
          }
        : {}),
    };
    const [entries, total] = await tenantBatch(ctx.db, [
      ctx.db.auditLog.findMany({
        where,
        orderBy: listOrder<Prisma.AuditLogOrderByWithRelationInput, typeof req.query.sort>(
          AuditList,
          req.query,
        ),
        take: req.query.limit,
        skip: req.query.offset,
      }),
      ctx.db.auditLog.count({ where }),
    ]);
    // AuditLog holds only the actor's id; the log is unreadable without the address behind it.
    const ids = [...new Set(entries.map((e) => e.actorId).filter((id): id is string => id !== null))];
    const actors = ids.length
      ? await ctx.db.user.findMany({
          // Scoped like every other tenant-owned read: an operator acting on this tenant stays
          // an opaque id here rather than exposing an address from another company.
          where: { id: { in: ids }, companyId: req.companyId },
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
  });
}

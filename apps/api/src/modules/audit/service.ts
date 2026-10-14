import { tenantBatch } from "@aidp/db";
import { toListResponse, type ListEnvelope } from "@aidp/shared";
import type { AuditLog, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { audit, type AuditEntry } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { toCsv } from "../campaigns/csv.js";
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

/** The most rows one export holds; the newest are kept and the response says when it was cut. */
export const AUDIT_CSV_MAX_ROWS = 10_000;

export const AuditListQuery = listQuery(AuditList);
export type AuditListQuery = z.output<typeof AuditListQuery>;

export type AuditEntryView = AuditLog & { actorEmail: string | null };

const isDateOnly = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);

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

/** The tenant's audit log: written by every admin action, read by `GET /audit`. */
export class AuditService {
  constructor(private readonly db: PrismaClient) {}

  /** Appends one row to this tenant's log. */
  async record(companyId: string, entry: AuditEntry): Promise<void> {
    await audit(this.db, companyId, entry);
  }

  /**
   * Appends a row unless the same actor already has one for the same action and target within
   * `withinMs` (D-262): a read repeated in a burst is one fact. Returns whether a row was written.
   * `requireTenant` skips the write when the tenant does not exist, for an operator header that
   * names nothing; the request itself is answered as it always was.
   */
  async recordOnce(
    companyId: string,
    entry: AuditEntry,
    withinMs: number,
    options: { requireTenant?: boolean } = {},
  ): Promise<boolean> {
    if (options.requireTenant) {
      const company = await this.db.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) return false;
    }
    const recent = await this.db.auditLog.findFirst({
      where: {
        companyId,
        actorId: entry.actorId,
        action: entry.action,
        targetId: entry.targetId,
        createdAt: { gte: new Date(Date.now() - withinMs) },
      },
      select: { id: true },
    });
    if (recent) return false;
    await audit(this.db, companyId, entry);
    return true;
  }

  /**
   * The log as a CSV, narrowed by the same search, action and date filters as the list (D-345).
   * Capped at `AUDIT_CSV_MAX_ROWS` newest-first; `truncated` says when there was more.
   */
  async exportCsv(
    companyId: string,
    query: Omit<AuditListQuery, "limit" | "offset">,
  ): Promise<{ filename: string; body: string; rows: number; truncated: boolean }> {
    const all: AuditEntryView[] = [];
    let truncated = false;
    for (let offset = 0; offset < AUDIT_CSV_MAX_ROWS; offset += 200) {
      const page = await this.list(companyId, { ...query, limit: 200, offset });
      all.push(...page.entries);
      if (page.entries.length < 200) break;
      if (offset + 200 >= AUDIT_CSV_MAX_ROWS) truncated = page.total > AUDIT_CSV_MAX_ROWS;
    }
    const body = toCsv(
      ["created_at", "actor", "action", "target_type", "target_id", "details"],
      all.map((e) => [
        e.createdAt.toISOString(),
        e.actorEmail ?? e.actorId ?? "",
        e.action,
        e.targetType ?? "",
        e.targetId ?? "",
        e.diff === null || e.diff === undefined ? "" : JSON.stringify(e.diff),
      ]),
    );
    const day = new Date().toISOString().slice(0, 10);
    return { filename: `audit-log-${day}.csv`, body, rows: all.length, truncated };
  }

  async list(companyId: string, query: AuditListQuery): Promise<ListEnvelope<"entries", AuditEntryView>> {
    const q = searchTerm(query.q);
    const action = query.action;
    // The log holds actor ids; a search by address resolves them inside this tenant only.
    const actorIds = q
      ? (
          await this.db.user.findMany({
            where: { companyId, OR: [{ email: contains(q) }, { name: contains(q) }] },
            select: { id: true },
            take: 500,
          })
        ).map((u) => u.id)
      : [];
    const createdAt = createdWindow(query.from, query.to);
    const where: Prisma.AuditLogWhereInput = {
      companyId,
      ...(createdAt ? { createdAt } : {}),
      ...(action ? { action: action.endsWith(".") ? { startsWith: escapeLike(action) } : action } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
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
    const [entries, total] = await tenantBatch(this.db, [
      this.db.auditLog.findMany({
        where,
        orderBy: listOrder<Prisma.AuditLogOrderByWithRelationInput, typeof query.sort>(AuditList, query),
        take: query.limit,
        skip: query.offset,
      }),
      this.db.auditLog.count({ where }),
    ]);
    // AuditLog holds only the actor's id; the log is unreadable without the address behind it.
    const ids = [...new Set(entries.map((e) => e.actorId).filter((id): id is string => id !== null))];
    const actors = ids.length
      ? await this.db.user.findMany({
          // Scoped like every other tenant-owned read: an operator acting on this tenant stays
          // an opaque id here rather than exposing an address from another company.
          where: { id: { in: ids }, companyId },
          select: { id: true, email: true },
        })
      : [];
    const emailOf = new Map(actors.map((a) => [a.id, a.email]));
    return toListResponse(
      "entries",
      entries.map((e) => ({
        ...e,
        actorEmail: e.actorId === null ? null : (emailOf.get(e.actorId) ?? null),
      })),
      total,
      query,
    );
  }
}

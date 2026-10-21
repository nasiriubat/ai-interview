import { hourKey, type ErrorLogPort } from "@aidp/core";
import { tenantBatch, withSystemTenant } from "@aidp/db";
import {
  ERROR_PERIODS,
  ERROR_SOURCES,
  ERROR_STATUSES,
  toListResponse,
  type BrowserErrorReport,
  type ListEnvelope,
  type WebErrorReport,
} from "@aidp/shared";
import type { ErrorGroup, ErrorOccurrence, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";
import { contains, listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";
import type { AuditService } from "../audit/service.js";

/**
 * The error log, from the operator's side (D-477): the groups, one group's recent occurrences,
 * the numbers for the sidebar badge and the health card, and the two verbs. Platform-wide by
 * definition, so every read and write is in the system context; the routes are operator-only.
 *
 * It also takes the reports that arrive over HTTP (a browser's, the web server's) and hands them
 * to the same recorder the API's own failures go to, which redacts and throttles them.
 */

const DAY_MS = 86_400_000;

/** `/operator/errors`. `q` matches the message, the error name or the route, or a group id exactly. */
export const ErrorGroupList = listSpec({
  sort: { lastSeenAt: "desc", firstSeenAt: "desc", count: "desc" },
  defaultSort: "lastSeenAt",
  filters: {
    source: z.enum(ERROR_SOURCES).optional(),
    /** A tenant id, or `platform` for the errors that belong to no tenant. */
    tenant: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(64)
      .optional(),
    status: z.enum(ERROR_STATUSES).default("open"),
    period: z.enum(ERROR_PERIODS).default("7d"),
  },
});
export const ErrorGroupListQuery = listQuery(ErrorGroupList);
export type ErrorGroupListQuery = z.output<typeof ErrorGroupListQuery>;

export interface ErrorGroupView {
  id: string;
  fingerprint: string;
  source: string;
  severity: string;
  name: string;
  message: string;
  route: string | null;
  jobName: string | null;
  companyId: string | null;
  tenantName: string | null;
  count: number;
  count24h: number;
  count7d: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  status: "open" | "resolved";
}

export type ErrorOccurrenceView = Omit<ErrorOccurrence, "groupId">;

export interface ErrorGroupDetail {
  group: ErrorGroupView;
  /** Newest first; at most the number kept per group. */
  occurrences: ErrorOccurrenceView[];
  /** The same fault (fingerprint) seen in this many other tenants, or the platform. */
  elsewhere: number;
}

export interface ErrorSummary {
  /** Unresolved groups seen in the last 24 hours: the sidebar badge. */
  open24h: number;
  /** Occurrences counted in the last 24 hours and 7 days, across every group. */
  last24h: number;
  last7d: number;
  /** Groups seen in the last 7 days, open or not. */
  groups7d: number;
}

/** Occurrences in the hourly counter from `since` on. */
function countSince(hourly: Prisma.JsonValue, since: Date): number {
  if (!hourly || typeof hourly !== "object" || Array.isArray(hourly)) return 0;
  const from = hourKey(since);
  let n = 0;
  for (const [key, value] of Object.entries(hourly)) if (key >= from && typeof value === "number") n += value;
  return n;
}

type GroupWithCompany = ErrorGroup & { company: { name: string } | null };

function view(g: GroupWithCompany, now: Date): ErrorGroupView {
  return {
    id: g.id,
    fingerprint: g.fingerprint,
    source: g.source,
    severity: g.severity,
    name: g.name,
    message: g.message,
    route: g.route,
    jobName: g.jobName,
    companyId: g.companyId,
    tenantName: g.company?.name ?? null,
    count: g.count,
    count24h: countSince(g.hourly, new Date(now.getTime() - DAY_MS)),
    count7d: countSince(g.hourly, new Date(now.getTime() - 7 * DAY_MS)),
    firstSeenAt: g.firstSeenAt,
    lastSeenAt: g.lastSeenAt,
    resolvedAt: g.resolvedAt,
    status: g.resolvedAt ? "resolved" : "open",
  };
}

/** Who is acting, and the operator's own company, which the audit row is filed under. */
export interface ErrorLogActor {
  userId: string;
  companyId: string;
}

/** What the browser route knows about who sent the report, from the credential the web attached. */
export interface Reporter {
  companyId?: string;
  userId?: string;
  sessionId?: string;
  userAgent?: string;
}

export class ErrorLogService {
  constructor(
    private readonly db: PrismaClient,
    private readonly audit: AuditService,
    private readonly errors: ErrorLogPort,
    private readonly release: string | undefined,
  ) {}

  async list(query: ErrorGroupListQuery, now = new Date()): Promise<ListEnvelope<"groups", ErrorGroupView>> {
    const q = searchTerm(query.q);
    const since =
      query.period === "24h"
        ? new Date(now.getTime() - DAY_MS)
        : query.period === "7d"
          ? new Date(now.getTime() - 7 * DAY_MS)
          : undefined;
    const where: Prisma.ErrorGroupWhereInput = {
      ...(query.source ? { source: query.source } : {}),
      ...(query.tenant ? { companyId: query.tenant === "platform" ? null : query.tenant } : {}),
      ...(query.status === "open" ? { resolvedAt: null } : {}),
      ...(query.status === "resolved" ? { resolvedAt: { not: null } } : {}),
      ...(since ? { lastSeenAt: { gte: since } } : {}),
      ...(q
        ? {
            OR: [
              { message: contains(q) },
              { name: contains(q) },
              { route: contains(q) },
              { jobName: contains(q) },
              { id: q },
            ],
          }
        : {}),
    };
    const [rows, total] = await withSystemTenant(() =>
      tenantBatch(this.db, [
        this.db.errorGroup.findMany({
          where,
          orderBy: listOrder<Prisma.ErrorGroupOrderByWithRelationInput, typeof query.sort>(
            ErrorGroupList,
            query,
          ),
          include: { company: { select: { name: true } } },
          take: query.limit,
          skip: query.offset,
        }),
        this.db.errorGroup.count({ where }),
      ]),
    );
    return toListResponse(
      "groups",
      rows.map((g) => view(g, now)),
      total,
      query,
    );
  }

  async get(id: string, now = new Date()): Promise<ErrorGroupDetail> {
    return withSystemTenant(async () => {
      const group = await this.db.errorGroup.findUnique({
        where: { id },
        include: {
          company: { select: { name: true } },
          occurrences: { orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 50 },
        },
      });
      if (!group) throw notFound("Error group");
      const elsewhere = await this.db.errorGroup.count({
        where: { fingerprint: group.fingerprint, id: { not: group.id } },
      });
      const { occurrences, ...rest } = group;
      return {
        group: view(rest, now),
        occurrences: occurrences.map(({ groupId: _g, ...o }) => o),
        elsewhere,
      };
    });
  }

  async summary(now = new Date()): Promise<ErrorSummary> {
    const day = new Date(now.getTime() - DAY_MS);
    const week = new Date(now.getTime() - 7 * DAY_MS);
    return withSystemTenant(async () => {
      const [open24h, groups7d, sums] = await Promise.all([
        this.db.errorGroup.count({ where: { resolvedAt: null, lastSeenAt: { gte: day } } }),
        this.db.errorGroup.count({ where: { lastSeenAt: { gte: week } } }),
        this.db.$queryRawUnsafe<{ d1: bigint | null; d7: bigint | null }[]>(
          `SELECT SUM(CASE WHEN h.key >= $1 THEN h.value::int ELSE 0 END) AS d1,
                  SUM(CASE WHEN h.key >= $2 THEN h.value::int ELSE 0 END) AS d7
             FROM "ErrorGroup" g, jsonb_each_text(g."hourly") h
            WHERE g."lastSeenAt" >= ($3::timestamptz AT TIME ZONE 'UTC')`,
          hourKey(day),
          hourKey(week),
          week.toISOString(),
        ),
      ]);
      return {
        open24h,
        groups7d,
        last24h: Number(sums[0]?.d1 ?? 0),
        last7d: Number(sums[0]?.d7 ?? 0),
      };
    });
  }

  /** Marks a group resolved. A new occurrence reopens it (the recorder clears `resolvedAt`). */
  async resolve(actor: ErrorLogActor, id: string): Promise<ErrorGroupView> {
    const now = new Date();
    const group = await withSystemTenant(async () => {
      const existing = await this.db.errorGroup.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw notFound("Error group");
      return this.db.errorGroup.update({
        where: { id },
        data: { resolvedAt: now, resolvedById: actor.userId },
        include: { company: { select: { name: true } } },
      });
    });
    await this.audit.record(actor.companyId, {
      actorId: actor.userId,
      action: "error_group.resolve",
      targetType: "error_group",
      targetId: id,
      diff: { source: group.source, name: group.name, route: group.route, count: group.count },
    });
    return view(group, now);
  }

  /** Removes a group and its occurrences. It comes back as a new group if it happens again. */
  async remove(actor: ErrorLogActor, id: string): Promise<void> {
    const group = await withSystemTenant(async () => {
      const existing = await this.db.errorGroup.findUnique({ where: { id } });
      if (!existing) throw notFound("Error group");
      await this.db.errorGroup.delete({ where: { id } });
      return existing;
    });
    await this.audit.record(actor.companyId, {
      actorId: actor.userId,
      action: "error_group.delete",
      targetType: "error_group",
      targetId: id,
      diff: { source: group.source, name: group.name, route: group.route, count: group.count },
    });
  }

  /** A browser's report, through the web app's proxy. Queued; the reply does not wait for a write. */
  recordBrowser(report: BrowserErrorReport, who: Reporter): void {
    this.errors.capture({
      source: "browser",
      name: report.name ?? (report.kind === "unhandledrejection" ? "UnhandledRejection" : "Error"),
      message: report.message,
      ...(report.stack ? { stack: report.stack } : {}),
      path: report.path,
      ...(who.companyId ? { companyId: who.companyId } : {}),
      ...(who.userId ? { userId: who.userId } : {}),
      ...(who.sessionId ? { sessionId: who.sessionId } : {}),
      ...(who.userAgent ? { userAgent: who.userAgent } : {}),
      ...(this.release ? { release: this.release } : {}),
    });
  }

  /** The web server's `onRequestError`, over the internal route. */
  recordWeb(report: WebErrorReport): void {
    this.errors.capture({
      source: "web",
      name: report.name ?? "Error",
      message: report.digest ? `${report.message} (digest ${report.digest})` : report.message,
      ...(report.stack ? { stack: report.stack } : {}),
      path: report.path,
      ...(report.routePath ? { route: report.routePath } : {}),
      ...(report.method ? { method: report.method } : {}),
      status: 500,
      ...(report.userAgent ? { userAgent: report.userAgent } : {}),
      ...((report.release ?? this.release) ? { release: report.release ?? this.release } : {}),
    });
  }
}

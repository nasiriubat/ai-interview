import { tenantBatch } from "@aidp/db";
import { toListResponse, type ListEnvelope } from "@aidp/shared";
import type { Budget, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError, notFound } from "../../lib/errors.js";
import { contains, listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";
import type { AuditService } from "../audit/service.js";

/** `/budgets` (D-79): `q` matches the target id exactly, or the name of a budgeted campaign. */
export const BudgetList = listSpec({
  sort: { createdAt: "asc", limitCents: "desc", scope: "asc" },
  defaultSort: "createdAt",
  filters: {
    scope: z.enum(["tenant", "campaign", "session"]).optional(),
    period: z.enum(["month", "total"]).optional(),
  },
});

export const BudgetListQuery = listQuery(BudgetList);
export type BudgetListQuery = z.output<typeof BudgetListQuery>;

export const BudgetBody = z.object({
  scope: z.enum(["tenant", "campaign", "session"]),
  scopeId: z.string().optional(),
  limitCents: z.number().int().min(0),
  period: z.enum(["month", "total"]),
});
export type BudgetBody = z.output<typeof BudgetBody>;

/** Spending limits per tenant, campaign or session. Every change is audited. */
export class BudgetService {
  constructor(
    private readonly db: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async list(companyId: string, query: BudgetListQuery): Promise<ListEnvelope<"budgets", Budget>> {
    const q = searchTerm(query.q);
    // A budget names its target by id; a search by name resolves campaigns in this tenant.
    const campaignIds = q
      ? (
          await this.db.campaign.findMany({
            where: { companyId, name: contains(q) },
            select: { id: true },
            take: 500,
          })
        ).map((c) => c.id)
      : [];
    const where: Prisma.BudgetWhereInput = {
      companyId,
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.period ? { period: query.period } : {}),
      ...(q
        ? {
            OR: [
              { scopeId: q },
              ...(campaignIds.length ? [{ scope: "campaign", scopeId: { in: campaignIds } }] : []),
            ],
          }
        : {}),
    };
    const [budgets, total] = await tenantBatch(this.db, [
      this.db.budget.findMany({
        where,
        orderBy: listOrder<Prisma.BudgetOrderByWithRelationInput, typeof query.sort>(BudgetList, query),
        take: query.limit,
        skip: query.offset,
      }),
      this.db.budget.count({ where }),
    ]);
    return toListResponse("budgets", budgets, total, query);
  }

  /** `operator` lifts the "may lower but not raise" rule on the tenant's own budget. */
  async set(companyId: string, actorId: string, operator: boolean, body: BudgetBody): Promise<Budget> {
    const scopeId = body.scope === "tenant" ? companyId : (body.scopeId ?? "");
    if (!scopeId) throw new AppError("validation", "A scopeId is required for this scope");
    if (body.scope === "tenant") {
      const company = await this.db.company.findFirstOrThrow({ where: { id: companyId } });
      if (!operator && body.limitCents > company.monthlyBudgetCents)
        throw new AppError(
          "validation",
          "A tenant may lower its budget but not raise it above the platform default",
        );
    }
    // A campaign or session id is never taken on trust: it has to belong to this tenant.
    if (body.scope === "campaign") {
      const c = await this.db.campaign.findFirst({
        where: { id: scopeId, companyId },
        select: { id: true },
      });
      if (!c) throw notFound("Campaign");
    }
    if (body.scope === "session") {
      const s = await this.db.session.findFirst({
        where: { id: scopeId, companyId },
        select: { id: true },
      });
      if (!s) throw notFound("Session");
    }
    const budget = await this.db.budget.upsert({
      where: { scope_scopeId: { scope: body.scope, scopeId } },
      create: { companyId, scope: body.scope, scopeId, limitCents: body.limitCents, period: body.period },
      update: { limitCents: body.limitCents, period: body.period },
    });
    await this.audit.record(companyId, {
      actorId,
      action: "budget.set",
      targetType: "budget",
      targetId: budget.id,
      diff: body,
    });
    return budget;
  }

  /** The tenant's own budget cannot be deleted, only lowered. */
  async remove(companyId: string, actorId: string, id: string): Promise<void> {
    const b = await this.db.budget.findFirst({ where: { id, companyId, scope: { not: "tenant" } } });
    if (!b) throw notFound("Budget");
    await this.db.budget.delete({ where: { id: b.id } });
    // The delete was the one admin action that wrote no audit row (found by the audit-row suite).
    await this.audit.record(companyId, {
      actorId,
      action: "budget.delete",
      targetType: "budget",
      targetId: b.id,
      diff: { scope: b.scope, scopeId: b.scopeId },
    });
  }
}

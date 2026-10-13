import { tenantBatch, tenantTransaction } from "@aidp/db";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { emailTaken, isUniqueViolation, notFound } from "../../lib/errors.js";
import { defined } from "../../lib/objects.js";
import { contains, listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";

/** `/operator/tenants` (D-79): `q` matches the name, or the id exactly. */
export const TenantList = listSpec({
  sort: { createdAt: "asc", name: "asc", status: "asc" },
  defaultSort: "createdAt",
  filters: {
    status: z.enum(["active", "suspended"]).optional(),
    region: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(20)
      .optional(),
  },
});

/** Platform operator: tenants and global numbers. Platform providers and routes use the provider routes with X-Company-Id unset and companyId null. */
export async function operatorRoutes(app: App, ctx: AppContext): Promise<void> {
  const op = guard.operator();

  app.get("/operator/tenants", { ...op, schema: { querystring: listQuery(TenantList) } }, async (req) => {
    const q = searchTerm(req.query.q);
    const where: Prisma.CompanyWhereInput = {
      ...(q ? { OR: [{ name: contains(q) }, { id: q }] } : {}),
      ...(req.query.status ? { status: req.query.status } : {}),
      ...(req.query.region ? { region: req.query.region } : {}),
    };
    const [tenants, total] = await tenantBatch(ctx.db, [
      ctx.db.company.findMany({
        where,
        orderBy: listOrder<Prisma.CompanyOrderByWithRelationInput, typeof req.query.sort>(
          TenantList,
          req.query,
        ),
        include: { _count: { select: { users: true, campaigns: true, sessions: true } } },
        take: req.query.limit,
        skip: req.query.offset,
      }),
      ctx.db.company.count({ where }),
    ]);
    return { tenants, total, limit: req.query.limit, offset: req.query.offset };
  });

  app.post(
    "/operator/tenants",
    {
      ...guard.operator({ config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }),
      schema: {
        body: z.object({
          name: z.string().min(1),
          region: z.string().default("eu"),
          adminEmail: z.email(),
          monthlyBudgetCents: z.number().int().min(0).optional(),
        }),
      },
    },
    async (req, reply) => {
      const budgetDefault = await ctx.settings.get("cost.defaultMonthlyBudgetCents", []);
      const limit = req.body.monthlyBudgetCents ?? budgetDefault;
      let company;
      try {
        company = await tenantTransaction(ctx.db, async (tx) => {
          const c = await tx.company.create({
            data: { name: req.body.name, region: req.body.region, monthlyBudgetCents: limit },
          });
          await tx.user.create({
            data: { companyId: c.id, email: req.body.adminEmail.toLowerCase(), role: "admin" },
          });
          await tx.budget.create({
            data: { companyId: c.id, scope: "tenant", scopeId: c.id, limitCents: limit, period: "month" },
          });
          return c;
        });
      } catch (err) {
        // The company insert rolls back with the user: no tenant is left without an admin.
        if (isUniqueViolation(err)) throw emailTaken();
        throw err;
      }
      await audit(ctx.db, {
        companyId: company.id,
        actorId: staff(req).userId,
        action: "tenant.create",
        targetType: "company",
        targetId: company.id,
      });
      return reply.status(201).send({ tenant: company });
    },
  );

  app.patch(
    "/operator/tenants/:id",
    {
      ...op,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          name: z.string().min(1).optional(),
          status: z.enum(["active", "suspended"]).optional(),
          monthlyBudgetCents: z.number().int().min(0).optional(),
        }),
      },
    },
    async (req) => {
      const existing = await ctx.db.company.findUnique({ where: { id: req.params.id } });
      if (!existing) throw notFound("Tenant");
      const tenant = await ctx.db.company.update({ where: { id: existing.id }, data: defined(req.body) });
      // This process sees the new status at once; the worker and any other replica within the
      // gate's short cache lifetime (S8).
      ctx.tenants.invalidate(tenant.id);
      if (req.body.monthlyBudgetCents !== undefined) {
        await ctx.db.budget.upsert({
          where: { scope_scopeId: { scope: "tenant", scopeId: tenant.id } },
          create: {
            companyId: tenant.id,
            scope: "tenant",
            scopeId: tenant.id,
            limitCents: req.body.monthlyBudgetCents,
            period: "month",
          },
          update: { limitCents: req.body.monthlyBudgetCents },
        });
      }
      await audit(ctx.db, {
        companyId: tenant.id,
        actorId: staff(req).userId,
        action: "tenant.update",
        targetType: "company",
        targetId: tenant.id,
        diff: req.body,
      });
      return { tenant };
    },
  );

  app.get("/operator/stats", op, async () => {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [tenants, sessions, spend] = await Promise.all([
      ctx.db.company.count(),
      ctx.db.session.groupBy({ by: ["status"], _count: { _all: true } }),
      ctx.db.llmCall.groupBy({
        by: ["companyId"],
        where: { createdAt: { gte: monthStart } },
        _sum: { costCents: true },
        _count: { _all: true },
      }),
    ]);
    return {
      tenants,
      sessions: Object.fromEntries(sessions.map((s) => [s.status, s._count._all])),
      spendByTenant: spend.map((s) => ({
        companyId: s.companyId,
        costCents: s._sum.costCents ?? 0,
        calls: s._count._all,
      })),
    };
  });
}

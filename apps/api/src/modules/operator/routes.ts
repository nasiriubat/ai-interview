import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff, staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { notFound } from "../../lib/errors.js";
import { defined } from "../../lib/objects.js";

/** Platform operator: tenants and global numbers. Platform providers and routes use the provider routes with X-Company-Id unset and companyId null. */
export async function operatorRoutes(app: App, ctx: AppContext): Promise<void> {
  const op = requireStaff("platform_operator");

  app.get("/operator/tenants", { preHandler: op }, async () => ({
    tenants: await ctx.db.company.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { users: true, campaigns: true, sessions: true } } },
    }),
  }));

  app.post(
    "/operator/tenants",
    {
      preHandler: op,
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
      const company = await ctx.db.$transaction(async (tx) => {
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
      preHandler: op,
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

  app.get("/operator/stats", { preHandler: op }, async () => {
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

import { tenantBatch } from "@aidp/db";
import { ProviderKindSchema, RoutablePurposeSchema } from "@aidp/shared";
import type { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff, staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { AppError, notFound } from "../../lib/errors.js";
import { contains, listOrder, listQuery, listSpec, searchTerm } from "../../lib/pagination.js";
import { expensiveLimit } from "../../lib/rate-limit.js";
import { ProviderService } from "./service.js";

const Id = z.object({ id: z.string() });
const ProviderBody = z.object({
  kind: ProviderKindSchema,
  name: z.string().min(1),
  baseUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});
/** `cachedInputPerMtok` is optional: a provider that does not price cached input charges full price. */
const PricesBody = z.object({
  prices: z.array(
    z.object({
      model: z.string().min(1),
      inputPerMtok: z.number().nonnegative(),
      outputPerMtok: z.number().nonnegative(),
      cachedInputPerMtok: z.number().nonnegative().optional(),
    }),
  ),
});
const TestBody = z.object({ model: z.string().min(1).optional() });
/** One row per purpose (contract 16). A row without provider or model clears the tenant override. */
const RouteRow = z.object({
  purpose: RoutablePurposeSchema,
  providerId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  maxOutputTokens: z.number().int().min(16).max(128000).nullable().optional(),
  batchAllowed: z.boolean().nullable().optional(),
});

type ScopeOf = (req: FastifyRequest) => string | null;

/** `/budgets` (D-79): `q` matches the target id exactly, or the name of a budgeted campaign. */
export const BudgetList = listSpec({
  sort: { createdAt: "asc", limitCents: "desc", scope: "asc" },
  defaultSort: "createdAt",
  filters: {
    scope: z.enum(["tenant", "campaign", "session"]).optional(),
    period: z.enum(["month", "total"]).optional(),
  },
});

/** `/providers/:id/prices` and its operator twin (D-79): `q` matches the model id. */
export const PriceList = listSpec({
  sort: { model: "asc", inputPerMtok: "asc", outputPerMtok: "asc", updatedAt: "desc" },
  defaultSort: "model",
  filters: { source: z.enum(["seed", "provider", "admin"]).optional() },
});

/** Providers, routing, prices, budgets. Platform operators without X-Company-Id manage platform-level rows. */
export async function providerRoutes(app: App, ctx: AppContext): Promise<void> {
  const svc = new ProviderService(ctx.db, ctx.crypto, ctx.callers, ctx.speech);
  const tenantScope: ScopeOf = (req) =>
    req.principal.kind === "staff" &&
    req.principal.role === "platform_operator" &&
    !req.headers["x-company-id"]
      ? null
      : req.companyId;

  mountProviderRoutes(app, ctx, svc, {
    prefix: "",
    preHandler: requireStaff("admin"),
    scope: tenantScope,
  });
  // The platform twins of the same routes (contract 19): operator only, always on companyId null.
  mountProviderRoutes(app, ctx, svc, {
    prefix: "/operator",
    preHandler: requireStaff("platform_operator"),
    scope: () => null,
  });

  app.get(
    "/budgets",
    { preHandler: requireStaff("admin"), schema: { querystring: listQuery(BudgetList) } },
    async (req) => {
      const q = searchTerm(req.query.q);
      // A budget names its target by id; a search by name resolves campaigns in this tenant.
      const campaignIds = q
        ? (
            await ctx.db.campaign.findMany({
              where: { companyId: req.companyId, name: contains(q) },
              select: { id: true },
              take: 500,
            })
          ).map((c) => c.id)
        : [];
      const where: Prisma.BudgetWhereInput = {
        companyId: req.companyId,
        ...(req.query.scope ? { scope: req.query.scope } : {}),
        ...(req.query.period ? { period: req.query.period } : {}),
        ...(q
          ? {
              OR: [
                { scopeId: q },
                ...(campaignIds.length ? [{ scope: "campaign", scopeId: { in: campaignIds } }] : []),
              ],
            }
          : {}),
      };
      const [budgets, total] = await tenantBatch(ctx.db, [
        ctx.db.budget.findMany({
          where,
          orderBy: listOrder<Prisma.BudgetOrderByWithRelationInput, typeof req.query.sort>(
            BudgetList,
            req.query,
          ),
          take: req.query.limit,
          skip: req.query.offset,
        }),
        ctx.db.budget.count({ where }),
      ]);
      return { budgets, total, limit: req.query.limit, offset: req.query.offset };
    },
  );
  app.post(
    "/budgets",
    {
      preHandler: requireStaff("admin"),
      schema: {
        body: z.object({
          scope: z.enum(["tenant", "campaign", "session"]),
          scopeId: z.string().optional(),
          limitCents: z.number().int().min(0),
          period: z.enum(["month", "total"]),
        }),
      },
    },
    async (req) => {
      const scopeId = req.body.scope === "tenant" ? req.companyId : (req.body.scopeId ?? "");
      if (!scopeId) throw new AppError("validation", "A scopeId is required for this scope");
      if (req.body.scope === "tenant") {
        const company = await ctx.db.company.findUniqueOrThrow({ where: { id: req.companyId } });
        if (staff(req).role !== "platform_operator" && req.body.limitCents > company.monthlyBudgetCents)
          throw new AppError(
            "validation",
            "A tenant may lower its budget but not raise it above the platform default",
          );
      }
      // A campaign or session id is never taken on trust: it has to belong to this tenant.
      if (req.body.scope === "campaign") {
        const c = await ctx.db.campaign.findFirst({
          where: { id: scopeId, companyId: req.companyId },
          select: { id: true },
        });
        if (!c) throw notFound("Campaign");
      }
      if (req.body.scope === "session") {
        const s = await ctx.db.session.findFirst({
          where: { id: scopeId, companyId: req.companyId },
          select: { id: true },
        });
        if (!s) throw notFound("Session");
      }
      const budget = await ctx.db.budget.upsert({
        where: { scope_scopeId: { scope: req.body.scope, scopeId } },
        create: {
          companyId: req.companyId,
          scope: req.body.scope,
          scopeId,
          limitCents: req.body.limitCents,
          period: req.body.period,
        },
        update: { limitCents: req.body.limitCents, period: req.body.period },
      });
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: staff(req).userId,
        action: "budget.set",
        targetType: "budget",
        targetId: budget.id,
        diff: req.body,
      });
      return { budget };
    },
  );
  app.delete("/budgets/:id", { preHandler: requireStaff("admin"), schema: { params: Id } }, async (req) => {
    const b = await ctx.db.budget.findFirst({
      where: { id: req.params.id, companyId: req.companyId, scope: { not: "tenant" } },
    });
    if (!b) throw notFound("Budget");
    await ctx.db.budget.delete({ where: { id: b.id } });
    return { ok: true as const };
  });
}

/**
 * Providers, models, prices and routes under one prefix. Mounted twice: once for tenant admins
 * and once for the platform operator, sharing the handlers so the two never drift apart.
 */
function mountProviderRoutes(
  app: App,
  ctx: AppContext,
  svc: ProviderService,
  opts: {
    prefix: "" | "/operator";
    preHandler: (req: FastifyRequest) => Promise<void>;
    scope: ScopeOf;
  },
): void {
  const { prefix, preHandler, scope } = opts;
  const view = (p: Awaited<ReturnType<ProviderService["get"]>>) => ({
    id: p.id,
    companyId: p.companyId,
    kind: p.kind,
    name: p.name,
    baseUrl: p.baseUrl,
    headers: p.headers,
    enabled: p.enabled,
    hasKey: p.apiKeyEnc.length > 0,
    createdAt: p.createdAt,
  });
  const auditCompany = (req: FastifyRequest): string => req.companyId || "platform";

  app.get(`${prefix}/providers`, { preHandler }, async (req) => ({
    providers: (await svc.list(scope(req))).map(view),
  }));

  app.post(`${prefix}/providers`, { preHandler, schema: { body: ProviderBody } }, async (req, reply) => {
    const p = await svc.create(scope(req), req.body);
    await audit(ctx.db, {
      companyId: auditCompany(req),
      actorId: staff(req).userId,
      action: "provider.create",
      targetType: "provider",
      targetId: p.id,
      diff: { kind: p.kind, name: p.name },
    });
    return reply.status(201).send({ provider: view(p) });
  });

  app.patch(
    `${prefix}/providers/:id`,
    { preHandler, schema: { params: Id, body: ProviderBody.partial() } },
    async (req) => {
      const p = await svc.update(scope(req), req.params.id, req.body);
      await audit(ctx.db, {
        companyId: auditCompany(req),
        actorId: staff(req).userId,
        action: "provider.update",
        targetType: "provider",
        targetId: p.id,
        diff: { ...req.body, apiKey: req.body.apiKey ? "(rotated)" : undefined },
      });
      return { provider: view(p) };
    },
  );

  app.delete(`${prefix}/providers/:id`, { preHandler, schema: { params: Id } }, async (req) => {
    await svc.remove(scope(req), req.params.id);
    await audit(ctx.db, {
      companyId: auditCompany(req),
      actorId: staff(req).userId,
      action: "provider.delete",
      targetType: "provider",
      targetId: req.params.id,
    });
    return { ok: true as const };
  });

  // The body is optional: without a model the service picks the routed one, then the first listed.
  app.post(
    `${prefix}/providers/:id/test`,
    { preHandler, ...expensiveLimit(ctx.config), schema: { params: Id } },
    async (req) => {
      const body = TestBody.parse(req.body ?? {});
      const result = await svc.test(scope(req), req.params.id, body.model);
      await audit(ctx.db, {
        companyId: auditCompany(req),
        actorId: staff(req).userId,
        action: "provider.test",
        targetType: "provider",
        targetId: req.params.id,
        diff: { ok: result.ok, model: result.model },
      });
      return result;
    },
  );

  app.get(
    `${prefix}/providers/:id/models`,
    { preHandler, ...expensiveLimit(ctx.config), schema: { params: Id } },
    async (req) => svc.models(scope(req), req.params.id),
  );

  app.get(
    `${prefix}/providers/:id/prices`,
    { preHandler, schema: { params: Id, querystring: listQuery(PriceList) } },
    async (req) => {
      await svc.get(scope(req), req.params.id);
      const q = searchTerm(req.query.q);
      const { prices, total } = await svc.pricesPage(req.params.id, {
        limit: req.query.limit,
        offset: req.query.offset,
        where: {
          ...(q ? { model: contains(q) } : {}),
          ...(req.query.source ? { source: req.query.source } : {}),
        },
        orderBy: listOrder<Prisma.ModelPriceOrderByWithRelationInput, typeof req.query.sort>(
          PriceList,
          req.query,
        ),
      });
      return { prices, total, limit: req.query.limit, offset: req.query.offset };
    },
  );

  app.put(
    `${prefix}/providers/:id/prices`,
    { preHandler, schema: { params: Id, body: PricesBody } },
    async (req) => {
      await svc.setPrices(
        scope(req),
        req.params.id,
        req.body.prices.map((p) => ({ ...p, cachedInputPerMtok: p.cachedInputPerMtok ?? p.inputPerMtok })),
      );
      await audit(ctx.db, {
        companyId: auditCompany(req),
        actorId: staff(req).userId,
        action: "prices.update",
        targetType: "provider",
        targetId: req.params.id,
        diff: req.body,
      });
      return { prices: await svc.prices(req.params.id) };
    },
  );

  app.get(`${prefix}/routes`, { preHandler }, async (req) => ({ routes: await svc.routes(scope(req)) }));

  app.put(
    `${prefix}/routes`,
    { preHandler, schema: { body: z.object({ routes: z.array(RouteRow) }) } },
    async (req) => {
      for (const row of req.body.routes) {
        const route =
          row.providerId && row.model
            ? {
                providerId: row.providerId,
                model: row.model,
                effort: row.effort ?? undefined,
                maxOutputTokens: row.maxOutputTokens ?? 4096,
                batchAllowed: row.batchAllowed ?? false,
              }
            : null;
        await svc.setRoute(scope(req), row.purpose, route);
      }
      await audit(ctx.db, {
        companyId: auditCompany(req),
        actorId: staff(req).userId,
        action: "routes.update",
        targetType: "routes",
        targetId: req.companyId || "platform",
        diff: req.body,
      });
      return { routes: await svc.routes(scope(req)) };
    },
  );
}

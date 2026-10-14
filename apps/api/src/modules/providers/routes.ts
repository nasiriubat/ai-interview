import { ProviderKindSchema, RoutablePurposeSchema } from "@aidp/shared";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard, withConfig, type RouteGuard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { expensiveLimit } from "../../lib/rate-limit.js";
import { BudgetBody, BudgetListQuery } from "./budgets.js";
import { PriceListQuery, type ProviderService } from "./service.js";

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
  /**
   * The route used when the primary's provider is down (D-228): omitted leaves it as it is, null
   * clears it, an object sets it.
   */
  fallback: z
    .object({ providerId: z.string().min(1), model: z.string().min(1) })
    .nullable()
    .optional(),
});

type ScopeOf = (req: FastifyRequest) => string | null;

/** Providers, routing, prices, budgets. Platform operators without X-Company-Id manage platform-level rows. */
export async function providerRoutes(app: App, ctx: RouteContext): Promise<void> {
  const svc = ctx.services.providers;
  const tenantScope: ScopeOf = (req) =>
    req.principal.kind === "staff" &&
    req.principal.role === "platform_operator" &&
    !req.headers["x-company-id"]
      ? null
      : req.companyId;

  mountProviderRoutes(app, ctx, svc, {
    prefix: "",
    guard: guard.admin(),
    scope: tenantScope,
  });
  // The platform twins of the same routes (contract 19): operator only, always on companyId null.
  mountProviderRoutes(app, ctx, svc, {
    prefix: "/operator",
    guard: guard.operator(),
    scope: () => null,
  });

  app.get("/budgets", { ...guard.admin(), schema: { querystring: BudgetListQuery } }, async (req) =>
    ctx.services.budgets.list(req.companyId, req.query),
  );
  app.post("/budgets", { ...guard.admin(), schema: { body: BudgetBody } }, async (req) => {
    const p = staff(req);
    return {
      budget: await ctx.services.budgets.set(
        req.companyId,
        p.userId,
        p.role === "platform_operator",
        req.body,
      ),
    };
  });
  app.delete("/budgets/:id", { ...guard.admin(), schema: { params: Id } }, async (req) => {
    await ctx.services.budgets.remove(req.companyId, staff(req).userId, req.params.id);
    return { ok: true as const };
  });
}

/**
 * Providers, models, prices and routes under one prefix. Mounted twice: once for tenant admins
 * and once for the platform operator, sharing the handlers so the two never drift apart.
 */
function mountProviderRoutes(
  app: App,
  ctx: RouteContext,
  svc: ProviderService,
  opts: {
    prefix: "" | "/operator";
    guard: RouteGuard;
    scope: ScopeOf;
  },
): void {
  const { prefix, guard: access, scope } = opts;
  /**
   * A provider as the browser receives it. Header values are never returned, only their names, and
   * a platform provider's header names are the operator's alone: a tenant that can use the provider
   * is not told how the operator's gateway is configured (D-147).
   */
  const view = (p: Awaited<ReturnType<ProviderService["get"]>>, req: FastifyRequest) => ({
    id: p.id,
    companyId: p.companyId,
    kind: p.kind,
    name: p.name,
    baseUrl: p.baseUrl,
    headerNames: p.companyId === null && scope(req) !== null ? [] : svc.headerNames(p),
    enabled: p.enabled,
    hasKey: p.apiKeyEnc.length > 0,
    createdAt: p.createdAt,
  });
  const auditCompany = (req: FastifyRequest): string => req.companyId || "platform";

  app.get(`${prefix}/providers`, access, async (req) => ({
    providers: (await svc.list(scope(req))).map((p) => view(p, req)),
  }));

  app.post(`${prefix}/providers`, { ...access, schema: { body: ProviderBody } }, async (req, reply) => {
    const p = await svc.create(scope(req), req.body);
    await ctx.services.audit.record(auditCompany(req), {
      actorId: staff(req).userId,
      action: "provider.create",
      targetType: "provider",
      targetId: p.id,
      diff: { kind: p.kind, name: p.name },
    });
    return reply.status(201).send({ provider: view(p, req) });
  });

  app.patch(
    `${prefix}/providers/:id`,
    { ...access, schema: { params: Id, body: ProviderBody.partial() } },
    async (req) => {
      const p = await svc.update(scope(req), req.params.id, req.body);
      await ctx.services.audit.record(auditCompany(req), {
        actorId: staff(req).userId,
        action: "provider.update",
        targetType: "provider",
        targetId: p.id,
        // Names, never values: the audit log is read by every administrator of the tenant, and
        // a header value is a credential like the key beside it.
        diff: {
          ...(req.body.kind !== undefined ? { kind: req.body.kind } : {}),
          ...(req.body.name !== undefined ? { name: req.body.name } : {}),
          ...(req.body.baseUrl !== undefined ? { baseUrl: req.body.baseUrl } : {}),
          ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}),
          ...(req.body.headers !== undefined ? { headerNames: Object.keys(req.body.headers).sort() } : {}),
          ...(req.body.apiKey ? { apiKey: "(rotated)" } : {}),
        },
      });
      return { provider: view(p, req) };
    },
  );

  app.delete(`${prefix}/providers/:id`, { ...access, schema: { params: Id } }, async (req) => {
    await svc.remove(scope(req), req.params.id);
    await ctx.services.audit.record(auditCompany(req), {
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
    { ...withConfig(access, expensiveLimit(ctx.config)), schema: { params: Id } },
    async (req) => {
      const body = TestBody.parse(req.body ?? {});
      const result = await svc.test(scope(req), req.params.id, body.model);
      await ctx.services.audit.record(auditCompany(req), {
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
    { ...withConfig(access, expensiveLimit(ctx.config)), schema: { params: Id } },
    async (req) => svc.models(scope(req), req.params.id),
  );

  app.get(
    `${prefix}/providers/:id/prices`,
    { ...access, schema: { params: Id, querystring: PriceListQuery } },
    async (req) => svc.pricesList(scope(req), req.params.id, req.query),
  );

  app.put(
    `${prefix}/providers/:id/prices`,
    { ...access, schema: { params: Id, body: PricesBody } },
    async (req) => {
      await svc.setPrices(
        scope(req),
        req.params.id,
        req.body.prices.map((p) => ({ ...p, cachedInputPerMtok: p.cachedInputPerMtok ?? p.inputPerMtok })),
      );
      await ctx.services.audit.record(auditCompany(req), {
        actorId: staff(req).userId,
        action: "prices.update",
        targetType: "provider",
        targetId: req.params.id,
        diff: req.body,
      });
      return { prices: await svc.prices(req.params.id) };
    },
  );

  app.get(`${prefix}/routes`, access, async (req) => ({ routes: await svc.routes(scope(req)) }));

  app.put(
    `${prefix}/routes`,
    { ...access, schema: { body: z.object({ routes: z.array(RouteRow) }) } },
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
        // Clearing the override clears its fallback with it; otherwise only what was said changes.
        const fallback = row.fallback !== undefined ? row.fallback : route === null ? null : undefined;
        if (fallback !== undefined) await svc.setFallback(scope(req), row.purpose, fallback);
      }
      await ctx.services.audit.record(auditCompany(req), {
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

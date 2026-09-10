import { PurposeSchema } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff, staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { notFound } from "../../lib/errors.js";
import { ProviderService } from "./service.js";

const Id = z.object({ id: z.string() });
const ProviderBody = z.object({
  kind: z.enum([
    "anthropic",
    "openai",
    "openrouter",
    "litellm",
    "openai_compatible",
    "stt",
    "tts",
    "realtime",
  ]),
  name: z.string().min(1),
  baseUrl: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});
const RouteBody = z.object({
  providerId: z.string(),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  maxOutputTokens: z.number().int().min(16).max(128000),
  batchAllowed: z.boolean().optional(),
});

/** Providers, routing, prices, budgets. Platform operators without X-Company-Id manage platform-level rows. */
export async function providerRoutes(app: App, ctx: AppContext): Promise<void> {
  const svc = new ProviderService(ctx.db, ctx.crypto, ctx.callers);
  const scope = (req: {
    companyId: string;
    principal: { kind: string; role?: string };
    headers: Record<string, unknown>;
  }): string | null =>
    req.principal.kind === "staff" &&
    req.principal.role === "platform_operator" &&
    !req.headers["x-company-id"]
      ? null
      : req.companyId;
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

  app.get("/providers", { preHandler: requireStaff("admin") }, async (req) => ({
    providers: (await svc.list(scope(req))).map(view),
  }));
  app.post(
    "/providers",
    { preHandler: requireStaff("admin"), schema: { body: ProviderBody } },
    async (req, reply) => {
      const p = await svc.create(scope(req), req.body);
      await audit(ctx.db, {
        companyId: req.companyId || "platform",
        actorId: staff(req).userId,
        action: "provider.create",
        targetType: "provider",
        targetId: p.id,
        diff: { kind: p.kind, name: p.name },
      });
      return reply.status(201).send({ provider: view(p) });
    },
  );
  app.patch(
    "/providers/:id",
    { preHandler: requireStaff("admin"), schema: { params: Id, body: ProviderBody.partial() } },
    async (req) => {
      const p = await svc.update(scope(req), req.params.id, req.body);
      await audit(ctx.db, {
        companyId: req.companyId || "platform",
        actorId: staff(req).userId,
        action: "provider.update",
        targetType: "provider",
        targetId: p.id,
        diff: { ...req.body, apiKey: req.body.apiKey ? "(rotated)" : undefined },
      });
      return { provider: view(p) };
    },
  );
  app.delete("/providers/:id", { preHandler: requireStaff("admin"), schema: { params: Id } }, async (req) => {
    await svc.remove(scope(req), req.params.id);
    await audit(ctx.db, {
      companyId: req.companyId || "platform",
      actorId: staff(req).userId,
      action: "provider.delete",
      targetType: "provider",
      targetId: req.params.id,
    });
    return { ok: true as const };
  });
  app.post(
    "/providers/:id/test",
    {
      preHandler: requireStaff("admin"),
      schema: { params: Id, body: z.object({ model: z.string().min(1) }) },
    },
    async (req) => svc.test(scope(req), req.params.id, req.body.model),
  );
  app.get(
    "/providers/:id/models",
    { preHandler: requireStaff("admin"), schema: { params: Id } },
    async (req) => svc.models(scope(req), req.params.id),
  );
  app.get(
    "/providers/:id/prices",
    { preHandler: requireStaff("admin"), schema: { params: Id } },
    async (req) => {
      await svc.get(scope(req), req.params.id);
      return { prices: await svc.prices(req.params.id) };
    },
  );
  app.put(
    "/providers/:id/prices",
    {
      preHandler: requireStaff("admin"),
      schema: {
        params: Id,
        body: z.object({
          prices: z.array(
            z.object({
              model: z.string(),
              inputPerMtok: z.number().nonnegative(),
              cachedInputPerMtok: z.number().nonnegative(),
              outputPerMtok: z.number().nonnegative(),
            }),
          ),
        }),
      },
    },
    async (req) => {
      for (const p of req.body.prices) await svc.setPrice(scope(req), req.params.id, p);
      await audit(ctx.db, {
        companyId: req.companyId || "platform",
        actorId: staff(req).userId,
        action: "prices.update",
        targetType: "provider",
        targetId: req.params.id,
        diff: req.body,
      });
      return { prices: await svc.prices(req.params.id) };
    },
  );

  app.get("/routes", { preHandler: requireStaff("admin") }, async (req) => ({
    routes: await svc.routes(scope(req)),
  }));
  app.put(
    "/routes",
    {
      preHandler: requireStaff("admin"),
      schema: { body: z.object({ routes: z.record(PurposeSchema, RouteBody.nullable()) }) },
    },
    async (req) => {
      for (const [purpose, route] of Object.entries(req.body.routes))
        await svc.setRoute(scope(req), PurposeSchema.parse(purpose), route);
      await audit(ctx.db, {
        companyId: req.companyId || "platform",
        actorId: staff(req).userId,
        action: "routes.update",
        targetType: "routes",
        targetId: req.companyId || "platform",
        diff: req.body,
      });
      return { routes: await svc.routes(scope(req)) };
    },
  );

  app.get("/budgets", { preHandler: requireStaff("admin") }, async (req) => ({
    budgets: await ctx.db.budget.findMany({ where: { companyId: req.companyId } }),
  }));
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
      if (!scopeId) throw notFound("Scope");
      if (req.body.scope === "tenant") {
        const company = await ctx.db.company.findUniqueOrThrow({ where: { id: req.companyId } });
        if (staff(req).role !== "platform_operator" && req.body.limitCents > company.monthlyBudgetCents)
          throw notFound("A tenant may lower its budget but not raise it above the platform default");
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

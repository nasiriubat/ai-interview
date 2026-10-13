import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { operatorJobRoutes } from "./jobs.js";
import { TenantCreateBody, TenantListQuery, TenantPatchBody } from "./service.js";

/** Platform operator: tenants and global numbers. Platform providers and routes use the provider routes with X-Company-Id unset and companyId null. */
export async function operatorRoutes(app: App, ctx: RouteContext): Promise<void> {
  const op = guard.operator();
  const operator = ctx.services.operator;
  await operatorJobRoutes(app, ctx);

  app.get("/operator/tenants", { ...op, schema: { querystring: TenantListQuery } }, async (req) =>
    operator.listTenants({ userId: staff(req).userId }, req.query),
  );

  app.post(
    "/operator/tenants",
    {
      ...guard.operator({ config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }),
      schema: { body: TenantCreateBody },
    },
    async (req, reply) => {
      const tenant = await operator.createTenant({ userId: staff(req).userId }, req.body);
      return reply.status(201).send({ tenant });
    },
  );

  app.patch(
    "/operator/tenants/:id",
    { ...op, schema: { params: z.object({ id: z.string() }), body: TenantPatchBody } },
    async (req) => ({
      tenant: await operator.updateTenant({ userId: staff(req).userId }, req.params.id, req.body),
    }),
  );

  app.get("/operator/stats", op, async (req) => operator.stats({ userId: staff(req).userId }));
}

import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { staff } from "../../auth/plugin.js";
import type { RouteContext } from "../../context.js";
import { operatorJobRoutes } from "./jobs.js";
import { TenantCreateBody, TenantListQuery, TenantPatchBody } from "./service.js";
import { operatorTenancyRoutes } from "./tenancy-ops.js";

/** Platform operator: tenants and global numbers. Platform providers and routes use the provider routes with X-Company-Id unset and companyId null. */
export async function operatorRoutes(app: App, ctx: RouteContext): Promise<void> {
  const op = guard.operator();
  const operator = ctx.services.operator;
  await operatorJobRoutes(app, ctx);
  await operatorTenancyRoutes(app, ctx);

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
      const { company, invitation } = await operator.createTenant({ userId: staff(req).userId }, req.body);
      return reply.status(201).send({ tenant: company, invitation });
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

  // Key rotation (P9, D-164): which key seals how many stored secrets, and the re-key that moves
  // them. Counts and key ids only; no key and no plaintext is ever returned.
  app.get("/operator/crypto/status", op, async () => ctx.services.cryptoAdmin.status());

  app.post(
    "/operator/crypto/rekey",
    { ...guard.operator({ config: { rateLimit: { max: 6, timeWindow: "1 hour" } } }) },
    async (req) => {
      await ctx.jobs.publish("crypto.rekey", {}, { singletonKey: "crypto.rekey" });
      await ctx.services.cryptoAdmin.recordRekeyRequested({ userId: staff(req).userId }, req.companyId);
      return { ok: true as const, queued: "crypto.rekey" };
    },
  );
}

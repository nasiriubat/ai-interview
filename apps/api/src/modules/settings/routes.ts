import { SettingsService } from "@aidp/core";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff, staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { forbidden } from "../../lib/errors.js";

const Scope = z.object({
  scope: z.enum(["platform", "tenant", "template", "campaign"]).default("tenant"),
  scopeId: z.string().default(""),
});

export async function settingsRoutes(app: App, ctx: AppContext): Promise<void> {
  const ref = (
    req: { companyId: string; principal: { kind: string; role?: string } },
    q: z.infer<typeof Scope>,
  ) => {
    if (q.scope === "platform") {
      if (req.principal.kind !== "staff" || req.principal.role !== "platform_operator")
        throw forbidden("Platform settings require the platform operator");
      return { scope: q.scope, scopeId: "" };
    }
    return { scope: q.scope, scopeId: q.scope === "tenant" ? req.companyId : q.scopeId };
  };

  app.get("/settings", { preHandler: requireStaff("admin"), schema: { querystring: Scope } }, async (req) => {
    const r = ref(req, req.query);
    const chain = r.scope === "platform" ? [] : [r, { scope: "tenant" as const, scopeId: req.companyId }];
    const catalog = SettingsService.catalog().filter((c) => c.scopes.includes(r.scope));
    const effective = await ctx.settings.resolveMany(
      catalog.map((c) => c.key),
      chain,
    );
    return { scope: r, values: await ctx.settings.listAt(r), effective, catalog };
  });

  app.put(
    "/settings",
    {
      preHandler: requireStaff("admin"),
      schema: { querystring: Scope, body: z.object({ values: z.record(z.string(), z.unknown()) }) },
    },
    async (req) => {
      const r = ref(req, req.query);
      const actor = staff(req).userId;
      const written = await ctx.settings.set(r, req.body.values, actor);
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: actor,
        action: "settings.update",
        targetType: `settings:${r.scope}`,
        targetId: r.scopeId || "platform",
        diff: req.body.values,
      });
      return { ok: true as const, written, values: await ctx.settings.listAt(r) };
    },
  );
}

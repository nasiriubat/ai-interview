import { SettingsService } from "@aidp/core";
import { maskSecretSettings, type SettingKey } from "@aidp/shared";
import { z } from "zod";
import type { App } from "../../app.js";
import { requireStaff, staff } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { audit } from "../../lib/audit.js";
import { AppError, forbidden, notFound } from "../../lib/errors.js";

const Scope = z.object({
  scope: z.enum(["platform", "tenant", "template", "campaign"]).default("tenant"),
  scopeId: z.string().default(""),
});
const TargetScope = z.object({ scope: z.enum(["template", "campaign", "tenant"]) });
const EmailTestBody = z.object({ scope: z.enum(["tenant", "platform"]).default("tenant") });

/** Never let a connection string reach a log line or a response body. */
function scrubSmtp(message: string): string {
  return message.replace(/smtps?:\/\/\S+/gi, "smtp://(hidden)");
}

export async function settingsRoutes(app: App, ctx: AppContext): Promise<void> {
  /**
   * The scope a request acts on, after checking the caller may see (or change) it. A template or
   * campaign id is never taken on trust: it must belong to the caller's tenant, and a platform
   * template is readable by an admin but writable only by the operator.
   */
  const ref = async (
    req: { companyId: string; principal: { kind: string; role?: string } },
    q: z.infer<typeof Scope>,
    mode: "read" | "write",
  ): Promise<{ scope: "platform" | "tenant" | "template" | "campaign"; scopeId: string }> => {
    const operator = req.principal.kind === "staff" && req.principal.role === "platform_operator";
    if (q.scope === "platform") {
      if (!operator) throw forbidden("Platform settings require the platform operator");
      return { scope: q.scope, scopeId: "" };
    }
    if (q.scope === "tenant") {
      // An operator may aim at another tenant, but only explicitly: silently rewriting the id to
      // their own company would show one tenant's values and save them onto another.
      if (q.scopeId && q.scopeId !== req.companyId) {
        if (!operator) throw forbidden("Another tenant's settings require the platform operator");
        const target = await ctx.db.company.findUnique({ where: { id: q.scopeId }, select: { id: true } });
        if (!target) throw notFound("Company");
        return { scope: q.scope, scopeId: q.scopeId };
      }
      return { scope: q.scope, scopeId: req.companyId };
    }
    if (!q.scopeId) throw new AppError("validation", `A ${q.scope} id is required for this scope`);
    if (q.scope === "template") {
      const t = await ctx.db.interviewTemplate.findFirst({
        where: { id: q.scopeId, OR: [{ companyId: req.companyId }, { companyId: null }] },
        select: { companyId: true },
      });
      if (!t) throw notFound("Template");
      if (t.companyId === null && mode === "write" && !operator)
        throw forbidden("Platform template settings require the platform operator");
      return { scope: q.scope, scopeId: q.scopeId };
    }
    const c = await ctx.db.campaign.findFirst({
      where: { id: q.scopeId, companyId: req.companyId },
      select: { id: true },
    });
    if (!c) throw notFound("Campaign");
    return { scope: q.scope, scopeId: q.scopeId };
  };

  app.get("/settings", { preHandler: requireStaff("admin"), schema: { querystring: Scope } }, async (req) => {
    const r = await ref(req, req.query, "read");
    const chain = r.scope === "platform" ? [] : [r, { scope: "tenant" as const, scopeId: req.companyId }];
    const catalog = SettingsService.catalog().filter((c) => c.scopes.includes(r.scope));
    const effective = await ctx.settings.resolveMany(
      catalog.map((c) => c.key),
      chain,
    );
    const at = await ctx.settings.describeAt(r);
    // Secrets leave the API as the sentinel, in the values set here and in the effective values alike.
    return {
      scope: r,
      values: at.values,
      secrets: at.secrets,
      effective: maskSecretSettings(effective),
      catalog,
    };
  });

  app.put(
    "/settings",
    {
      preHandler: requireStaff("admin"),
      schema: { querystring: Scope, body: z.object({ values: z.record(z.string(), z.unknown()) }) },
    },
    async (req) => {
      const r = await ref(req, req.query, "write");
      const actor = staff(req).userId;
      const written = await ctx.settings.set(r, req.body.values, actor);
      const at = await ctx.settings.describeAt(r);
      // The audit diff names the keys that were submitted and never carries a value with it.
      await audit(ctx.db, {
        companyId: req.companyId,
        actorId: actor,
        action: "settings.update",
        targetType: `settings:${r.scope}`,
        targetId: r.scopeId || "platform",
        diff: { keys: Object.keys(req.body.values), written, cleared: clearedKeys(req.body.values) },
      });
      return { ok: true as const, written, values: at.values, secrets: at.secrets };
    },
  );

  /** Names for the scope pickers, so nobody types an id by hand (contract 19). */
  app.get(
    "/settings/scopes",
    { preHandler: requireStaff("admin"), schema: { querystring: TargetScope } },
    async (req) => {
      if (req.query.scope === "template") {
        const rows = await ctx.db.interviewTemplate.findMany({
          where: { companyId: req.companyId },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, key: true, version: true },
        });
        return { targets: rows.map((t) => ({ id: t.id, name: t.name, detail: `${t.key} v${t.version}` })) };
      }
      if (req.query.scope === "campaign") {
        const rows = await ctx.db.campaign.findMany({
          where: { companyId: req.companyId },
          orderBy: { createdAt: "desc" },
          select: { id: true, name: true, status: true },
        });
        return { targets: rows.map((c) => ({ id: c.id, name: c.name, detail: c.status })) };
      }
      const operator = staff(req).role === "platform_operator";
      const rows = await ctx.db.company.findMany({
        where: operator ? {} : { id: req.companyId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, region: true },
      });
      return { targets: rows.map((c) => ({ id: c.id, name: c.name, detail: c.region })) };
    },
  );

  /** Sends one message to the caller with the configuration in effect, and says which scope won. */
  app.post("/settings/email/test", { preHandler: requireStaff("admin") }, async (req) => {
    // The body is optional, so it is parsed here rather than by the route schema.
    const body = EmailTestBody.parse(req.body ?? {});
    const p = staff(req);
    if (body.scope === "platform" && p.role !== "platform_operator")
      throw forbidden("Only a platform operator may test the platform email configuration");
    const tenant = body.scope === "tenant";
    const chain = tenant ? [{ scope: "tenant" as const, scopeId: req.companyId }] : [];
    const resolved = await ctx.settings.resolveDetailed(["email.smtpUrl"], chain);
    const entry = resolved["email.smtpUrl"];
    const configured = typeof entry?.value === "string" && entry.value.length > 0;
    const usedScope =
      configured && (entry.scope === "tenant" || entry.scope === "platform") ? entry.scope : "env";
    let ok = true;
    let error: string | undefined;
    try {
      await ctx.email.send({
        to: p.email,
        ...(tenant ? { companyId: req.companyId } : {}),
        subject: "Test message",
        text: `This is a test message from the ${body.scope} email configuration.`,
      });
    } catch (e) {
      ok = false;
      // Deliberately coarse: the raw errno distinguishes refused from filtered from wrong-protocol,
      // which turns this endpoint into an internal port scanner. The detail goes to the log only.
      ctx.log.warn({ err: e, companyId: req.companyId, scope: body.scope }, "email test failed");
      error = scrubSmtp(
        e instanceof Error && e.name === "AppError" ? e.message : "Could not send through this configuration",
      );
    }
    await audit(ctx.db, {
      companyId: req.companyId,
      actorId: p.userId,
      action: "settings.email_test",
      targetType: `settings:${body.scope}`,
      targetId: tenant ? req.companyId : "platform",
      diff: { scope: body.scope, usedScope, ok },
    });
    return { ok, usedScope, ...(error !== undefined ? { error } : {}) };
  });
}

function clearedKeys(values: Record<string, unknown>): SettingKey[] {
  return Object.entries(values)
    .filter(([, v]) => v === null)
    .map(([k]) => k as SettingKey);
}

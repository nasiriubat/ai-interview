import { EgressBlockedError, SettingsService, type EgressGuard, type EmailPort } from "@aidp/core";
import { isSmtpUrl, maskSecretSettings, SECRET_SENTINEL, type SettingKey } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError, forbidden, notFound } from "../../lib/errors.js";
import type { AuditService } from "../audit/service.js";

export const SettingsScopeQuery = z.object({
  scope: z.enum(["platform", "tenant", "template", "campaign"]).default("tenant"),
  scopeId: z.string().default(""),
});
export type SettingsScopeQuery = z.output<typeof SettingsScopeQuery>;

export const TargetScopeQuery = z.object({ scope: z.enum(["template", "campaign", "tenant"]) });
export type TargetScopeQuery = z.output<typeof TargetScopeQuery>;

export const EmailTestBody = z.object({ scope: z.enum(["tenant", "platform"]).default("tenant") });
export type EmailTestBody = z.output<typeof EmailTestBody>;

/** Who is calling: the tenant the request acts on, and whether they are the platform operator. */
export interface SettingsCaller {
  companyId: string;
  userId: string;
  email: string;
  operator: boolean;
}

/** The scope after the caller was checked against it. */
export interface ResolvedScope {
  scope: "platform" | "tenant" | "template" | "campaign";
  scopeId: string;
}

type Described = Awaited<ReturnType<SettingsService["describeAt"]>>;

export interface SettingsView {
  scope: ResolvedScope;
  values: Described["values"];
  secrets: Described["secrets"];
  effective: ReturnType<typeof maskSecretSettings>;
  catalog: ReturnType<typeof SettingsService.catalog>;
}

/** Never let a connection string reach a log line or a response body. */
function scrubSmtp(message: string): string {
  return message.replace(/smtps?:\/\/\S+/gi, "smtp://(hidden)");
}

function clearedKeys(values: Record<string, unknown>): SettingKey[] {
  return Object.entries(values)
    .filter(([, v]) => v === null)
    .map(([k]) => k as SettingKey);
}

/**
 * Settings as an admin edits them: scope resolution and checks, secret masking, the egress check
 * on a typed mail relay, and the audit row for each change. Wraps `SettingsService`, which is the
 * store; this is the policy around it.
 */
export class SettingsAdminService {
  constructor(
    private readonly db: PrismaClient,
    private readonly settings: SettingsService,
    private readonly egress: EgressGuard,
    private readonly email: EmailPort,
    private readonly audit: AuditService,
    private readonly log: { warn(meta: object, message: string): void },
  ) {}

  /**
   * The scope a request acts on, after checking the caller may see (or change) it. A template or
   * campaign id is never taken on trust: it must belong to the caller's tenant, and a platform
   * template is readable by an admin but writable only by the operator.
   */
  private async resolveScope(
    caller: SettingsCaller,
    q: SettingsScopeQuery,
    mode: "read" | "write",
  ): Promise<ResolvedScope> {
    const { companyId, operator } = caller;
    if (q.scope === "platform") {
      if (!operator) throw forbidden("Platform settings require the platform operator");
      return { scope: q.scope, scopeId: "" };
    }
    if (q.scope === "tenant") {
      // An operator may aim at another tenant, but only explicitly: silently rewriting the id to
      // their own company would show one tenant's values and save them onto another.
      if (q.scopeId && q.scopeId !== companyId) {
        if (!operator) throw forbidden("Another tenant's settings require the platform operator");
        const target = await this.db.company.findUnique({ where: { id: q.scopeId }, select: { id: true } });
        if (!target) throw notFound("Company");
        return { scope: q.scope, scopeId: q.scopeId };
      }
      return { scope: q.scope, scopeId: companyId };
    }
    if (!q.scopeId) throw new AppError("validation", `A ${q.scope} id is required for this scope`);
    if (q.scope === "template") {
      const t = await this.db.interviewTemplate.findFirst({
        where: { id: q.scopeId, OR: [{ companyId }, { companyId: null }] },
        select: { companyId: true },
      });
      if (!t) throw notFound("Template");
      if (t.companyId === null && mode === "write" && !operator)
        throw forbidden("Platform template settings require the platform operator");
      return { scope: q.scope, scopeId: q.scopeId };
    }
    const c = await this.db.campaign.findFirst({
      where: { id: q.scopeId, companyId },
      select: { id: true },
    });
    if (!c) throw notFound("Campaign");
    return { scope: q.scope, scopeId: q.scopeId };
  }

  async read(caller: SettingsCaller, q: SettingsScopeQuery): Promise<SettingsView> {
    const r = await this.resolveScope(caller, q, "read");
    const chain = r.scope === "platform" ? [] : [r, { scope: "tenant" as const, scopeId: caller.companyId }];
    const catalog = SettingsService.catalog().filter((c) => c.scopes.includes(r.scope));
    const effective = await this.settings.resolveMany(
      catalog.map((c) => c.key),
      chain,
    );
    const at = await this.settings.describeAt(r);
    // Secrets leave the API as the sentinel, in the values set here and in the effective values alike.
    return {
      scope: r,
      values: at.values,
      secrets: at.secrets,
      effective: maskSecretSettings(effective),
      catalog,
    };
  }

  /**
   * A relay a tenant types is a destination the server will connect to, so it meets the egress
   * policy when it is saved (S4). The sentinel and a clear are not new addresses. The connect-time
   * check in the transport is the authoritative one; this gives the admin the answer at the form.
   */
  private async assertRelayAllowed(scope: string, value: unknown): Promise<void> {
    if (typeof value !== "string" || value === "" || value === SECRET_SENTINEL) return;
    // Not an SMTP URL at all is the settings catalog's 400 to give, not a policy refusal.
    if (!isSmtpUrl(value)) return;
    try {
      await this.egress.validateSmtpUrl(value, scope === "platform" ? "platform" : "tenant");
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        throw new AppError("blocked_address", "That mail server address is not allowed", {
          reason: err.reason,
        });
      }
      throw err;
    }
  }

  async write(
    caller: SettingsCaller,
    q: SettingsScopeQuery,
    values: Record<string, unknown>,
  ): Promise<{
    ok: true;
    written: SettingKey[];
    values: Described["values"];
    secrets: Described["secrets"];
  }> {
    const r = await this.resolveScope(caller, q, "write");
    await this.assertRelayAllowed(r.scope, values["email.smtpUrl"]);
    const written = await this.settings.set(r, values, caller.userId);
    const at = await this.settings.describeAt(r);
    // The audit diff names the keys that were submitted and never carries a value with it.
    await this.audit.record(caller.companyId, {
      actorId: caller.userId,
      action: "settings.update",
      targetType: `settings:${r.scope}`,
      targetId: r.scopeId || "platform",
      diff: { keys: Object.keys(values), written, cleared: clearedKeys(values) },
    });
    return { ok: true as const, written, values: at.values, secrets: at.secrets };
  }

  /** Names for the scope pickers, so nobody types an id by hand (contract 19). */
  async targets(
    caller: SettingsCaller,
    scope: TargetScopeQuery["scope"],
  ): Promise<{ targets: { id: string; name: string; detail: string }[] }> {
    const { companyId } = caller;
    if (scope === "template") {
      const rows = await this.db.interviewTemplate.findMany({
        where: { companyId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, key: true, version: true },
      });
      return { targets: rows.map((t) => ({ id: t.id, name: t.name, detail: `${t.key} v${t.version}` })) };
    }
    if (scope === "campaign") {
      const rows = await this.db.campaign.findMany({
        where: { companyId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, status: true },
      });
      return { targets: rows.map((c) => ({ id: c.id, name: c.name, detail: c.status })) };
    }
    const rows = await this.db.company.findMany({
      where: caller.operator ? {} : { id: companyId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, region: true },
    });
    return { targets: rows.map((c) => ({ id: c.id, name: c.name, detail: c.region })) };
  }

  /** Sends one message to the caller with the configuration in effect, and says which scope won. */
  async emailTest(
    caller: SettingsCaller,
    body: EmailTestBody,
  ): Promise<{ ok: boolean; usedScope: string; error?: string }> {
    if (body.scope === "platform" && !caller.operator)
      throw forbidden("Only a platform operator may test the platform email configuration");
    const { companyId } = caller;
    const tenant = body.scope === "tenant";
    const chain = tenant ? [{ scope: "tenant" as const, scopeId: companyId }] : [];
    const resolved = await this.settings.resolveDetailed(["email.smtpUrl"], chain);
    const entry = resolved["email.smtpUrl"];
    const configured = typeof entry?.value === "string" && entry.value.length > 0;
    const usedScope =
      configured && (entry.scope === "tenant" || entry.scope === "platform") ? entry.scope : "env";
    let ok = true;
    let error: string | undefined;
    try {
      await this.email.send({
        to: caller.email,
        ...(tenant ? { companyId } : {}),
        subject: "Test message",
        text: `This is a test message from the ${body.scope} email configuration.`,
      });
    } catch (e) {
      ok = false;
      // Deliberately coarse: the raw errno distinguishes refused from filtered from wrong-protocol,
      // which turns this endpoint into an internal port scanner. The detail goes to the log only.
      this.log.warn({ err: e, companyId, scope: body.scope }, "email test failed");
      error = scrubSmtp(
        e instanceof Error && e.name === "AppError" ? e.message : "Could not send through this configuration",
      );
    }
    await this.audit.record(companyId, {
      actorId: caller.userId,
      action: "settings.email_test",
      targetType: `settings:${body.scope}`,
      targetId: tenant ? companyId : "platform",
      diff: { scope: body.scope, usedScope, ok },
    });
    return { ok, usedScope, ...(error !== undefined ? { error } : {}) };
  }
}

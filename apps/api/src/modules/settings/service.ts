import { EgressBlockedError, SettingsService, type EgressGuard, type EmailPort } from "@aidp/core";
import { withSystemTenant } from "@aidp/db";
import {
  isOperatorOnlySetting,
  isSmtpUrl,
  maskSecretSettings,
  SECRET_SENTINEL,
  SETTINGS,
  type SettingKey,
} from "@aidp/shared";
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

/** `GET /settings/history`: newest first, paged by the time of the last row seen. */
export const SettingsHistoryQuery = z.object({
  scope: z.enum(["platform", "tenant", "template", "campaign"]).optional(),
  scopeId: z.string().optional(),
  key: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9.]*$/)
    .max(80)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});
export type SettingsHistoryQuery = z.output<typeof SettingsHistoryQuery>;

export interface SettingsHistoryItem {
  id: string;
  at: string;
  scope: string;
  scopeId: string;
  /** The template's or campaign's name, when the scope names one that still exists. */
  scopeName: string | null;
  actor: { id: string; name: string | null; email: string } | null;
  /** Keys written in this save, and the subset that was reset to the inherited value. */
  keys: string[];
  cleared: string[];
}

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
   * A platform operator names the scope it acts on explicitly (`resolveScope` checks it), and
   * platform rows and other tenants' rows are outside any single tenant's policy. So an operator's
   * settings work runs in the system context even when `X-Company-Id` pinned the request to one
   * tenant; everyone else stays inside their own (D-141).
   */
  private asCaller<T>(caller: SettingsCaller, fn: () => Promise<T>): Promise<T> {
    return caller.operator ? withSystemTenant(fn) : fn();
  }

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

  read(caller: SettingsCaller, q: SettingsScopeQuery): Promise<SettingsView> {
    return this.asCaller(caller, () => this.readAs(caller, q));
  }

  private async readAs(caller: SettingsCaller, q: SettingsScopeQuery): Promise<SettingsView> {
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

  write(
    caller: SettingsCaller,
    q: SettingsScopeQuery,
    values: Record<string, unknown>,
  ): ReturnType<SettingsAdminService["writeAs"]> {
    return this.asCaller(caller, () => this.writeAs(caller, q, values));
  }

  private async writeAs(
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
    // A ceiling is a promise the operator makes about the platform: no tenant writes one, at any
    // scope, whatever the form sends (D-188).
    const operatorOnly = Object.keys(values).filter(
      (k) => k in SETTINGS && isOperatorOnlySetting(k as SettingKey),
    );
    if (operatorOnly.length > 0 && !caller.operator)
      throw forbidden(`Set by your platform operator: ${operatorOnly.join(", ")}`);
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

  /**
   * Who changed which settings and when, from the audit log (D-182). The log records the keys
   * and never a value, so this answers "what changed" and not "from what to what"; a secret's
   * value cannot leak through it by construction. Platform changes are the operator's to see.
   */
  history(
    caller: SettingsCaller,
    q: SettingsHistoryQuery,
  ): Promise<{ items: SettingsHistoryItem[]; next: string | null }> {
    return this.asCaller(caller, () => this.historyAs(caller, q));
  }

  private async historyAs(
    caller: SettingsCaller,
    q: SettingsHistoryQuery,
  ): Promise<{ items: SettingsHistoryItem[]; next: string | null }> {
    const { companyId, operator } = caller;
    if (q.scope === "platform" && !operator)
      throw forbidden("Platform settings history requires the platform operator");
    const rows = await this.db.auditLog.findMany({
      where: {
        companyId,
        action: "settings.update",
        ...(q.scope
          ? { targetType: `settings:${q.scope}` }
          : operator
            ? {}
            : { targetType: { not: "settings:platform" } }),
        ...(q.scopeId ? { targetId: q.scopeId } : {}),
        ...(q.key ? { diff: { path: ["keys"], array_contains: q.key } } : {}),
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const actorIds = [...new Set(page.map((r) => r.actorId).filter((id): id is string => id !== null))];
    const templateIds = page.filter((r) => r.targetType === "settings:template").map((r) => r.targetId);
    const campaignIds = page.filter((r) => r.targetType === "settings:campaign").map((r) => r.targetId);
    const [actors, templates, campaigns] = await Promise.all([
      actorIds.length
        ? this.db.user.findMany({
            where: { id: { in: actorIds }, companyId },
            select: { id: true, name: true, email: true },
          })
        : [],
      templateIds.length
        ? this.db.interviewTemplate.findMany({
            where: { id: { in: templateIds }, OR: [{ companyId }, { companyId: null }] },
            select: { id: true, name: true, version: true },
          })
        : [],
      campaignIds.length
        ? this.db.campaign.findMany({
            where: { id: { in: campaignIds }, companyId },
            select: { id: true, name: true },
          })
        : [],
    ]);
    const actorOf = new Map(actors.map((a) => [a.id, a]));
    const names = new Map<string, string>([
      ...templates.map((t) => [t.id, `${t.name} v${t.version}`] as const),
      ...campaigns.map((c) => [c.id, c.name] as const),
    ]);
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const items = page.map((r): SettingsHistoryItem => {
      const diff = (r.diff ?? {}) as { keys?: unknown; cleared?: unknown };
      const a = r.actorId ? actorOf.get(r.actorId) : undefined;
      const scope = r.targetType.replace(/^settings:/, "");
      return {
        id: r.id,
        at: r.createdAt.toISOString(),
        scope,
        scopeId: r.targetId === "platform" ? "" : r.targetId,
        scopeName: names.get(r.targetId) ?? null,
        actor: a ? { id: a.id, name: a.name, email: a.email } : null,
        keys: strings(diff.keys),
        cleared: strings(diff.cleared),
      };
    });
    const last = page[page.length - 1];
    return { items, next: rows.length > q.limit && last ? last.createdAt.toISOString() : null };
  }

  /** Names for the scope pickers, so nobody types an id by hand (contract 19). */
  targets(
    caller: SettingsCaller,
    scope: TargetScopeQuery["scope"],
  ): Promise<{ targets: { id: string; name: string; detail: string }[] }> {
    return this.asCaller(caller, () => this.targetsAs(caller, scope));
  }

  private async targetsAs(
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
  emailTest(
    caller: SettingsCaller,
    body: EmailTestBody,
  ): Promise<{ ok: boolean; usedScope: string; error?: string }> {
    return this.asCaller(caller, () => this.emailTestAs(caller, body));
  }

  private async emailTestAs(
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

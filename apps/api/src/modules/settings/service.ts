import {
  EgressBlockedError,
  sendTestMessage,
  SettingsService,
  SMTP_ERROR_MESSAGES,
  classifySmtpError,
  type EgressGuard,
  type EmailPort,
  type SmtpErrorClass,
} from "@aidp/core";
import { withSystemTenant } from "@aidp/db";
import {
  isOperatorOnlySetting,
  isSmtpUrl,
  maskSecretSettings,
  SECRET_SENTINEL,
  SETTINGS,
  SmtpFormSchema,
  isEmailAddress,
  smtpUrlFromForm,
  summariseSmtpUrl,
  type SettingKey,
  type SmtpForm,
  type SmtpSummary,
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

/**
 * `scope` picks whose configuration is exercised. `smtp`, `from` and `replyTo` are additive and
 * optional (D-412): sent, they test what is on the form without saving it, with the stored password
 * standing in when the form says it is unchanged.
 */
export const EmailTestBody = z.object({
  scope: z.enum(["tenant", "platform"]).default("tenant"),
  smtp: SmtpFormSchema.optional(),
  from: z.string().trim().max(320).optional(),
  replyTo: z.string().trim().max(320).optional(),
});
export type EmailTestBody = z.output<typeof EmailTestBody>;

/** Why a test send did not go: an SMTP class, or that no relay is configured at all. */
export type EmailTestErrorClass = SmtpErrorClass | "not_configured";

export interface EmailTestResult {
  ok: boolean;
  usedScope: string;
  error?: string;
  errorClass?: EmailTestErrorClass;
}

/** What the SMTP form needs to show about the relay at one scope and where the effective one is from. */
export interface SmtpView {
  /** The relay written at the scope being viewed; null when this scope sets none. */
  set: SmtpSummary | null;
  /** Which scope's relay is in force for a send from here. `none`: nothing can send mail. */
  effective: "tenant" | "platform" | "env" | "none";
  /** Whether the deployment's EMAIL_SMTP_URL exists. Its host is never shown to a tenant. */
  envConfigured: boolean;
}

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
  /** Present for the platform and tenant scopes: the relay taken apart, without its password. */
  smtp?: SmtpView;
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
    /** Whether EMAIL_SMTP_URL is set in the deployment; the value itself never comes here. */
    private readonly envSmtpConfigured = false,
    /** EMAIL_FROM: the sender when neither scope sets one. */
    private readonly envFrom = "no-reply@example.com",
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
    const smtp = r.scope === "platform" || r.scope === "tenant" ? await this.smtpView(r) : undefined;
    return {
      scope: r,
      values: at.values,
      secrets: at.secrets,
      effective: maskSecretSettings(effective),
      catalog,
      ...(smtp ? { smtp } : {}),
    };
  }

  /** The relay stored at exactly this scope (with its password), or undefined. Server side only. */
  private async storedSmtpUrl(r: ResolvedScope): Promise<string | undefined> {
    const chain = r.scope === "platform" ? [] : [r];
    const entry = (await this.settings.resolveDetailed(["email.smtpUrl"], chain))["email.smtpUrl"];
    if (entry?.scope !== r.scope || typeof entry.value !== "string" || entry.value === "") return undefined;
    return entry.value;
  }

  private async smtpView(r: ResolvedScope): Promise<SmtpView> {
    const stored = await this.storedSmtpUrl(r);
    const chain = r.scope === "platform" ? [] : [r];
    const entry = (await this.settings.resolveDetailed(["email.smtpUrl"], chain))["email.smtpUrl"];
    const inForce = typeof entry?.value === "string" && entry.value !== "";
    const effective: SmtpView["effective"] =
      inForce && (entry.scope === "tenant" || entry.scope === "platform")
        ? entry.scope
        : this.envSmtpConfigured
          ? "env"
          : "none";
    return {
      set: stored ? summariseSmtpUrl(stored) : null,
      effective,
      envConfigured: this.envSmtpConfigured,
    };
  }

  /** Turns the structured form into the `email.smtpUrl` value, keeping a stored password on request. */
  private async composeFromForm(r: ResolvedScope, form: SmtpForm): Promise<string> {
    try {
      return smtpUrlFromForm(form, await this.storedSmtpUrl(r));
    } catch {
      throw new AppError("validation", "That is not a valid mail server host or port");
    }
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
    smtp?: SmtpForm,
  ): ReturnType<SettingsAdminService["writeAs"]> {
    return this.asCaller(caller, () => this.writeAs(caller, q, values, smtp));
  }

  private async writeAs(
    caller: SettingsCaller,
    q: SettingsScopeQuery,
    submitted: Record<string, unknown>,
    smtp?: SmtpForm,
  ): Promise<{
    ok: true;
    written: SettingKey[];
    values: Described["values"];
    secrets: Described["secrets"];
  }> {
    const r = await this.resolveScope(caller, q, "write");
    let values = submitted;
    if (smtp) {
      // The structured form and the raw string are two ways of saying one thing; both at once is a bug.
      const raw = submitted["email.smtpUrl"];
      if (raw !== undefined && raw !== SECRET_SENTINEL)
        throw new AppError("validation", "Send either smtp or email.smtpUrl, not both");
      if (r.scope !== "platform" && r.scope !== "tenant")
        throw new AppError("validation", "Mail settings exist at the platform and tenant scopes");
      values = { ...submitted, "email.smtpUrl": await this.composeFromForm(r, smtp) };
    }
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

  /**
   * Sends one message to the caller. With no `smtp` in the body it uses the configuration in
   * effect (what a real send would use); with one, it uses the form's relay without saving it, so
   * an admin finds out before committing. Failures come back as a class and a sentence (D-412).
   */
  emailTest(caller: SettingsCaller, body: EmailTestBody): Promise<EmailTestResult> {
    return this.asCaller(caller, () => this.emailTestAs(caller, body));
  }

  private async emailTestAs(caller: SettingsCaller, body: EmailTestBody): Promise<EmailTestResult> {
    if (body.scope === "platform" && !caller.operator)
      throw forbidden("Only a platform operator may test the platform email configuration");
    const { companyId } = caller;
    const tenant = body.scope === "tenant";
    // The tenant is always the caller's own, and the message goes to the caller's own address.
    const r: ResolvedScope = tenant
      ? { scope: "tenant", scopeId: companyId }
      : { scope: "platform", scopeId: "" };
    const addressOk = (v: string): boolean =>
      !/[\r\n]/.test(v) && (isEmailAddress(v) || /<[^<>\s]+@[^<>\s]+>$/.test(v));
    if (body.from && !addressOk(body.from))
      throw new AppError("validation", "The sender is not an email address");
    if (body.replyTo && !addressOk(body.replyTo))
      throw new AppError("validation", "The reply-to is not an email address");

    const view = await this.smtpView(r);
    const subject = "Test message";
    const text = `This is a test message from the ${body.scope} email configuration.`;

    if (body.smtp) {
      // Unsaved: exercise exactly what the form holds, under the policy a saved value would meet.
      let url: string;
      try {
        url = await this.composeFromForm(r, body.smtp);
      } catch {
        return this.finishTest(
          caller,
          body,
          body.scope,
          { ok: false, errorClass: "unknown" },
          "Invalid host or port",
        );
      }
      const from = body.from !== undefined && body.from !== "" ? body.from : await this.currentFrom(r);
      const sent = await sendTestMessage({
        url,
        from,
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
        to: caller.email,
        subject,
        text,
        origin: tenant ? "tenant" : "platform",
        egress: this.egress,
      });
      if (!sent.ok) {
        this.log.warn({ err: sent.cause, companyId, scope: body.scope }, "email test failed");
        return this.finishTest(caller, body, body.scope, { ok: false, errorClass: sent.errorClass });
      }
      return this.finishTest(caller, body, body.scope, { ok: true });
    }

    const usedScope = view.effective === "none" ? "env" : view.effective;
    if (view.effective === "none") {
      // The platform would only log the message. Saying "sent" would be a lie an admin acts on.
      return this.finishTest(caller, body, usedScope, { ok: false, errorClass: "not_configured" });
    }
    try {
      await this.email.send({
        to: caller.email,
        ...(tenant ? { companyId } : {}),
        ...(body.from ? { from: body.from } : {}),
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
        subject,
        text,
      });
    } catch (e) {
      // The detail goes to the log only; the response carries the class and a fixed sentence.
      this.log.warn({ err: e, companyId, scope: body.scope }, "email test failed");
      return this.finishTest(caller, body, usedScope, { ok: false, errorClass: classifySmtpError(e) });
    }
    return this.finishTest(caller, body, usedScope, { ok: true });
  }

  /** The sender a real send from this scope would use, for a test that has not typed one. */
  private async currentFrom(r: ResolvedScope): Promise<string> {
    const chain = r.scope === "platform" ? [] : [r];
    const resolved = await this.settings.resolveDetailed(["email.from", "branding.emailSender"], chain);
    const set = (k: "email.from" | "branding.emailSender"): string => {
      const e = resolved[k];
      return e?.scope != null && typeof e.value === "string" ? e.value : "";
    };
    return set("email.from") || set("branding.emailSender") || this.envFrom;
  }

  private async finishTest(
    caller: SettingsCaller,
    body: EmailTestBody,
    usedScope: string,
    outcome: { ok: true } | { ok: false; errorClass: EmailTestErrorClass },
    detail?: string,
  ): Promise<EmailTestResult> {
    const tenant = body.scope === "tenant";
    await this.audit.record(caller.companyId, {
      actorId: caller.userId,
      action: "settings.email_test",
      targetType: `settings:${body.scope}`,
      targetId: tenant ? caller.companyId : "platform",
      diff: {
        scope: body.scope,
        usedScope,
        ok: outcome.ok,
        unsaved: body.smtp !== undefined,
        ...(outcome.ok ? {} : { errorClass: outcome.errorClass }),
      },
    });
    if (outcome.ok) return { ok: true, usedScope };
    const message =
      detail ??
      (outcome.errorClass === "not_configured"
        ? "No mail server is configured, so nothing can be sent. Set one below, or ask the platform operator."
        : SMTP_ERROR_MESSAGES[outcome.errorClass]);
    return { ok: false, usedScope, errorClass: outcome.errorClass, error: scrubSmtp(message) };
  }
}

import { withSystemTenant } from "@aidp/db";
import type { SettingKey } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import type { EmailPort } from "../email/port.js";
import type { SettingsService } from "../settings/service.js";
import { EmailAlertChannel } from "./email-alerts.js";
import { ALERT_KINDS, runbookRef } from "./kinds.js";
import {
  SEVERITY_RANK,
  type Alert,
  type AlertPort,
  type Audience,
  type RaiseResult,
  type Severity,
} from "./port.js";
import { scrubContext, scrubText, type RenderedAlert } from "./render.js";
import type { AlertState } from "./state.js";
import { WebhookAlertChannel, type WebhookFormat } from "./webhook-alerts.js";

export interface AlertRouterDeps {
  db: PrismaClient;
  state: AlertState;
  settings: SettingsService;
  /** The platform email port (SettingsEmail). A tenant notice passes `companyId` so its SMTP applies. */
  email: EmailPort;
  /** Deep links are built from this. */
  publicWebUrl: string;
  /**
   * What deploy/.env says when the catalog has no value: the same variables `deploy/ops/notify.sh`
   * reads, so the app and the sidecar tell the same person the same way before anyone has opened
   * the settings screen.
   */
  env?: {
    alertEmail?: string | undefined;
    alertWebhookUrl?: string | undefined;
    alertWebhookFormat?: WebhookFormat | undefined;
  };
  fetch?: typeof fetch;
  log?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => Date;
}

interface OpsConfig {
  email: string;
  webhookUrl: string;
  webhookFormat: WebhookFormat;
  emailMin: Severity;
  webhookMin: Severity;
  repeatOverrideMinutes: number | null;
  maxPerHour: number;
}

const OPS_KEYS: SettingKey[] = [
  "ops.alertEmail",
  "ops.alertWebhookUrl",
  "ops.alertWebhookFormat",
  "ops.alertEmailMinSeverity",
  "ops.alertWebhookMinSeverity",
  "ops.alertRepeatMinutes",
  "ops.alertMaxPerHour",
];

/** The first value that is not empty: an empty setting means "not set here", so the next source wins. */
const firstNonEmpty = (...values: (string | undefined)[]): string => values.find((v) => v) ?? "";

const CONFIG_TTL_MS = 30_000;
const MAX_MESSAGE = 1000;
const MAX_TITLE = 200;

/**
 * Turns an `Alert` into notifications (D-90).
 *
 * Order matters and is the whole design: the severity floors are checked first so an `info`
 * notice below every floor costs nothing; the store then settles dedupe in one conditional write,
 * so a condition that persists for a day is one email and a counter; the hourly limit comes last,
 * so a flapping source ends in one "storm" notice and silence rather than a flooded phone.
 *
 * `raise` never throws. A caller sits in the middle of a model call or a job handler, and an
 * outage of the channel that reports outages must not become a second outage.
 */
export class AlertRouter implements AlertPort {
  private readonly email: EmailAlertChannel;
  private readonly webhook: WebhookAlertChannel;
  private readonly now: () => Date;
  private config: { value: OpsConfig; at: number } | undefined;
  private platformCompany: string | null | undefined;

  constructor(private readonly deps: AlertRouterDeps) {
    this.email = new EmailAlertChannel(deps.email);
    this.webhook = new WebhookAlertChannel(deps.fetch ? { fetch: deps.fetch } : {});
    this.now = deps.now ?? (() => new Date());
  }

  async raise(alert: Alert): Promise<RaiseResult> {
    try {
      return await this.route(alert, true);
    } catch (err) {
      this.deps.log?.warn("alert could not be routed", {
        kind: alert.kind,
        key: alert.key,
        err: String(err),
      });
      return { delivered: false, suppressed: null };
    }
  }

  async resolve(key: string): Promise<void> {
    try {
      await this.deps.state.resolve(key, this.now());
    } catch (err) {
      this.deps.log?.warn("alert could not be resolved", { key, err: String(err) });
    }
  }

  private async route(alert: Alert, limited: boolean): Promise<RaiseResult> {
    const spec = ALERT_KINDS[alert.kind];
    const severity: Severity = alert.severity ?? spec.severity;
    const now = this.now();
    const cfg = await this.opsConfig();

    // The catalog's audience is a ceiling. An alert may name fewer audiences, never more, so a
    // call site cannot mail a tenant something the catalog keeps between the operator and the box.
    const allowed = spec.audience as readonly Audience[];
    const wanted = alert.audience ? allowed.filter((a) => alert.audience?.includes(a)) : allowed;
    const toTenant = wanted.includes("tenant_admins") && alert.companyId !== undefined;
    const toOperator = wanted.includes("operator");

    const emailOk = cfg.email !== "" && SEVERITY_RANK[severity] >= SEVERITY_RANK[cfg.emailMin];
    const webhookOk = cfg.webhookUrl !== "" && SEVERITY_RANK[severity] >= SEVERITY_RANK[cfg.webhookMin];
    const floorsBlock =
      toOperator &&
      SEVERITY_RANK[severity] < Math.min(SEVERITY_RANK[cfg.emailMin], SEVERITY_RANK[cfg.webhookMin]);
    if (!toTenant && floorsBlock) return { delivered: false, suppressed: "below_min_severity" };

    const repeatMinutes = cfg.repeatOverrideMinutes ?? spec.repeatMinutes;
    const occurrence = await this.deps.state.record({
      key: alert.key,
      kind: alert.kind,
      severity,
      companyId: alert.companyId,
      title: scrubText(alert.title, MAX_TITLE),
      message: scrubText(alert.message, MAX_MESSAGE),
      context: scrubContext(alert.context),
      now,
      repeatMs: repeatMinutes * 60_000,
    });
    if (!occurrence.notify) return { delivered: occurrence.alreadyDelivered, suppressed: "duplicate" };

    const rendered: RenderedAlert = {
      kind: alert.kind,
      severity,
      key: alert.key,
      title: scrubText(alert.title, MAX_TITLE),
      message: scrubText(alert.message, MAX_MESSAGE),
      ...(alert.companyId ? { companyId: alert.companyId } : {}),
      occurredAt: alert.occurredAt ?? now,
      count: occurrence.count,
      context: scrubContext(alert.context),
      links: alert.links ?? [],
    };

    // Hourly ceiling, per audience (and per tenant for tenant mail, so a noisy tenant cannot use
    // up another's allowance). Counted at claim time: a notification we are about to attempt.
    const hour = now.toISOString().slice(0, 13);
    let operatorLimited = false;
    let tenantLimited = false;
    if (limited) {
      if (toOperator && (emailOk || webhookOk)) {
        const n = await this.deps.state.bump(`operator:${hour}`, now);
        if (n > cfg.maxPerHour) {
          operatorLimited = true;
          if (n === cfg.maxPerHour + 1) await this.storm("operator", cfg, now);
        }
      }
      if (toTenant && alert.companyId) {
        const n = await this.deps.state.bump(`tenant:${alert.companyId}:${hour}`, now);
        if (n > cfg.maxPerHour) {
          tenantLimited = true;
          if (n === cfg.maxPerHour + 1) await this.storm(`tenant ${alert.companyId}`, cfg, now);
        }
      }
    }

    const sent: string[] = [];
    if (toOperator && !operatorLimited) {
      const operatorAlert = { ...rendered, runbook: runbookRef(alert.kind) };
      const prefix = `[aidp ${this.hostname()}]`;
      if (emailOk) {
        await this.attempt(sent, "email", () =>
          this.email.send({ to: cfg.email, subjectPrefix: prefix, alert: operatorAlert }),
        );
      }
      if (webhookOk) {
        await this.attempt(sent, "webhook", () =>
          this.webhook.send({
            url: cfg.webhookUrl,
            format: cfg.webhookFormat,
            alert: operatorAlert,
            subjectPrefix: prefix,
          }),
        );
      }
    }
    if (toTenant && !tenantLimited && alert.companyId) {
      await this.notifyTenant(alert.companyId, alert, rendered, sent);
    }

    if (sent.length === 0) {
      // Nothing went out. Give the claim back, so the next occurrence tries again immediately
      // instead of being swallowed as a duplicate of a notification that never happened.
      await this.deps.state.release(alert.key);
      const limitedOut = operatorLimited || tenantLimited;
      return { delivered: false, suppressed: limitedOut ? "rate_limited" : null };
    }
    await this.auditSent(alert, severity, sent);
    return { delivered: true, suppressed: null };
  }

  private async notifyTenant(
    companyId: string,
    alert: Alert,
    rendered: RenderedAlert,
    sent: string[],
  ): Promise<void> {
    const spec = ALERT_KINDS[alert.kind];
    const chain = [{ scope: "tenant" as const, scopeId: companyId }];
    if ("tenantSetting" in spec) {
      const enabled = await this.deps.settings.get(spec.tenantSetting, chain);
      if (!enabled) return;
    }
    const [configured, productName] = await Promise.all([
      this.deps.settings.get("notifications.recipients", chain),
      this.deps.settings.get("branding.productName", chain),
    ]);
    const recipients =
      configured.length > 0
        ? configured
        : await withSystemTenant(async () =>
            (
              await this.deps.db.user.findMany({
                where: { companyId, role: "admin" },
                select: { email: true },
              })
            ).map((u) => u.email),
          );
    const prefix = `[${scrubText(productName, 60)}]`;
    const footer = `You receive this because you are an admin of this workspace. Who is notified is set under Settings, Notifications: ${this.deps.publicWebUrl.replace(/\/+$/, "")}/admin/settings?category=notifications`;
    for (const to of [...new Set(recipients)]) {
      await this.attempt(sent, "tenant_email", () =>
        this.email.send({ to, subjectPrefix: prefix, alert: rendered, companyId, footer }),
      );
    }
  }

  private async attempt(sent: string[], channel: string, send: () => Promise<void>): Promise<void> {
    try {
      await send();
      sent.push(channel);
    } catch (err) {
      // The error text is not logged: a webhook URL or an SMTP host is a credential.
      this.deps.log?.warn("alert channel failed", {
        channel,
        reason: err instanceof Error ? err.name : "error",
      });
    }
  }

  /** Exactly one notice per bucket and hour, sent to the operator whatever else is suppressed. */
  private async storm(scope: string, cfg: OpsConfig, now: Date): Promise<void> {
    const since = new Date(now.getTime() - 3_600_000);
    const top = await this.deps.state.topKinds(since, 1);
    const worst = top[0] ? `, most often ${top[0].kind}` : "";
    await this.route(
      {
        kind: "alerts.storm",
        key: `alerts.storm:${scope}:${now.toISOString().slice(0, 13)}`,
        title: "Alerts are being suppressed",
        message: `${cfg.maxPerHour} alerts were sent in the last hour for ${scope}; the rest are suppressed until the next hour${worst}. Look at the OpsAlert table or the operator jobs page rather than waiting for more notices.`,
        context: { limitPerHour: cfg.maxPerHour },
      },
      false,
    );
  }

  private async auditSent(alert: Alert, severity: Severity, channels: string[]): Promise<void> {
    try {
      const companyId = alert.companyId ?? (await this.platformCompanyId());
      if (!companyId) return;
      // `async` and `await` are load-bearing: a Prisma query is lazy, so returning it unawaited
      // would run it after the system context has been left.
      await withSystemTenant(async () => {
        await this.deps.db.auditLog.create({
          data: {
            companyId,
            actorId: null,
            action: "alert.sent",
            targetType: "alert",
            targetId: alert.key,
            diff: { kind: alert.kind, severity, channels },
          },
        });
      });
    } catch (err) {
      this.deps.log?.warn("alert audit row failed", { key: alert.key, err: String(err) });
    }
  }

  /** The company the platform operator belongs to; an operator alert is audited there. */
  private async platformCompanyId(): Promise<string | null> {
    if (this.platformCompany !== undefined) return this.platformCompany;
    const op = await withSystemTenant(async () => {
      return await this.deps.db.user.findFirst({
        where: { role: "platform_operator" },
        orderBy: { createdAt: "asc" },
        select: { companyId: true, email: true },
      });
    });
    this.platformCompany = op?.companyId ?? null;
    return this.platformCompany;
  }

  private hostname(): string {
    try {
      return new URL(this.deps.publicWebUrl).host;
    } catch {
      return "platform";
    }
  }

  private async opsConfig(): Promise<OpsConfig> {
    const now = this.now().getTime();
    if (this.config && now - this.config.at < CONFIG_TTL_MS) return this.config.value;
    const r = await this.deps.settings.resolveDetailed(OPS_KEYS, []);
    const str = (k: SettingKey): string => {
      const v = r[k]?.value;
      return typeof v === "string" ? v : "";
    };
    const explicit = (k: SettingKey): boolean => r[k]?.scope != null;
    const env = this.deps.env ?? {};
    let email = firstNonEmpty(str("ops.alertEmail"), env.alertEmail);
    if (!email) {
      const op = await withSystemTenant(async () => {
        return await this.deps.db.user.findFirst({
          where: { role: "platform_operator" },
          orderBy: { createdAt: "asc" },
          select: { email: true },
        });
      });
      email = op?.email ?? "";
    }
    const severity = (k: SettingKey): Severity => {
      const v = r[k]?.value;
      return v === "info" || v === "warning" || v === "critical" ? v : "info";
    };
    const repeat = r["ops.alertRepeatMinutes"];
    const value: OpsConfig = {
      email,
      webhookUrl: firstNonEmpty(str("ops.alertWebhookUrl"), env.alertWebhookUrl),
      webhookFormat: explicit("ops.alertWebhookFormat")
        ? (str("ops.alertWebhookFormat") as WebhookFormat)
        : (env.alertWebhookFormat ?? (str("ops.alertWebhookFormat") as WebhookFormat)),
      emailMin: severity("ops.alertEmailMinSeverity"),
      webhookMin: severity("ops.alertWebhookMinSeverity"),
      repeatOverrideMinutes:
        explicit("ops.alertRepeatMinutes") && typeof repeat?.value === "number" ? repeat.value : null,
      maxPerHour: typeof r["ops.alertMaxPerHour"]?.value === "number" ? r["ops.alertMaxPerHour"].value : 30,
    };
    this.config = { value, at: now };
    return value;
  }
}

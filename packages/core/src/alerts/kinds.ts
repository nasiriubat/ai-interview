import type { SettingKey } from "@aidp/shared";
import type { Audience, Severity } from "./port.js";

/**
 * The alert catalog (D-90): one row per kind, and the only place a kind is defined.
 *
 * Three things are checked against it by tests, so a kind cannot be added half-way:
 * `docs/OPERATIONS.md` must have a `### <kind>` section for every row (the runbook the alert
 * links to), `deploy/ops/notify.sh` and the other shell producers may only emit kinds named here,
 * and every row has a test that provokes it.
 */
export interface AlertKindSpec {
  /** What the kind is raised at unless the source says otherwise. */
  severity: Severity;
  /** Who may ever hear about it. A source can narrow this and never widen it. */
  audience: readonly Audience[];
  /** Minutes before an unresolved condition is sent again. `ops.alertRepeatMinutes` overrides it when set. */
  repeatMinutes: number;
  /** One line for the operator UI and the runbook index. */
  summary: string;
  /**
   * A tenant switch that silences the tenant's copy. The operator's copy is never switchable by a
   * tenant: it is the platform's money and the platform's uptime.
   */
  tenantSetting?: SettingKey;
}

const TEN_YEARS_MINUTES = 10 * 365 * 24 * 60;

export const ALERT_KINDS = {
  "budget.warning": {
    severity: "info",
    audience: ["operator", "tenant_admins"],
    repeatMinutes: 1440,
    summary: "A budget passed its warning threshold",
    tenantSetting: "notifications.budgetWarnings",
  },
  "budget.exceeded": {
    severity: "warning",
    audience: ["operator", "tenant_admins"],
    repeatMinutes: 1440,
    summary: "A budget is used up and interviews under it are paused",
  },
  // Tenant notices (D-181): events a tenant's admins want to hear about, each behind its own
  // switch. They are never sent to the operator: they are the tenant's work, not the platform's.
  // The repeat window is ten years, so one event is one mail however often its source re-checks.
  "campaign.threshold": {
    severity: "info",
    audience: ["tenant_admins"],
    repeatMinutes: TEN_YEARS_MINUTES,
    summary: "A campaign reached its completion threshold and its analysis is queued",
    tenantSetting: "notifications.campaignThreshold",
  },
  "analysis.ready": {
    severity: "info",
    audience: ["tenant_admins"],
    repeatMinutes: TEN_YEARS_MINUTES,
    summary: "An analysis finished and its report can be read",
    tenantSetting: "notifications.analysisReady",
  },
  "spec.ready": {
    severity: "info",
    audience: ["tenant_admins"],
    repeatMinutes: TEN_YEARS_MINUTES,
    summary: "A specification version was generated",
    tenantSetting: "notifications.specReady",
  },
  "ceiling.warning": {
    severity: "info",
    audience: ["operator", "tenant_admins"],
    repeatMinutes: 1440,
    summary: "A tenant ceiling is at 80 percent",
  },
  "ceiling.reached": {
    severity: "warning",
    audience: ["operator", "tenant_admins"],
    repeatMinutes: 1440,
    summary: "A tenant ceiling is used up and the next campaign or interview is refused",
  },
  "session.flagged": {
    severity: "warning",
    audience: ["tenant_admins"],
    repeatMinutes: 1440,
    summary: "An interview was flagged for hostility or distress and needs a person to look at it",
  },
  "job.dead_lettered": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 1440,
    summary: "A background job failed its last attempt and sits in a dead-letter queue",
  },
  "job.stuck": {
    severity: "warning",
    audience: ["operator"],
    repeatMinutes: 60,
    summary: "Jobs are active past their expiry; queue maintenance may not be running",
  },
  "backup.failed": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 720,
    summary: "The last backup run failed",
  },
  "backup.missing": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 360,
    summary: "No successful backup within the allowed age",
  },
  "backup.offsite_failed": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 720,
    summary: "The offsite copy of the backup failed",
  },
  "disk.high": {
    severity: "warning",
    audience: ["operator"],
    repeatMinutes: 360,
    summary: "Disk use is above the warning or critical threshold",
  },
  "provider.error_rate": {
    severity: "warning",
    audience: ["operator"],
    repeatMinutes: 60,
    summary: "A model provider is failing a large share of calls",
  },
  "provider.fallback_active": {
    severity: "warning",
    audience: ["operator"],
    repeatMinutes: 60,
    summary: "A purpose is being served by its fallback route because the primary provider is down",
  },
  "backup.drill_failed": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 720,
    summary: "The weekly restore drill could not restore the latest backup or its row counts did not match",
  },
  "tenant.offboarded": {
    severity: "info",
    audience: ["operator"],
    repeatMinutes: TEN_YEARS_MINUTES,
    summary: "A tenant's data was removed and the erasure was recorded",
  },
  "rls.preflight_failed": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 60,
    summary: "The row-level-security preflight refused to start the stack",
  },
  "tls.renewal": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 720,
    summary: "The TLS certificate is close to expiry and has not been renewed",
  },
  "worker.heartbeat_stale": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 60,
    summary: "The worker has not confirmed that it can reach the job queue",
  },
  "api.down": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 60,
    summary: "The API has not answered its readiness check",
  },
  // An interview link hit one of its abuse limits (D-261): a campaign's hourly or total cap, the
  // tenant's hourly cap, or one client address asking codes for too many different addresses. The
  // tenant's admins hear about it because the link is theirs; the operator because it is also the
  // platform's mail reputation and model spend.
  "abuse.limit_hit": {
    severity: "warning",
    audience: ["operator", "tenant_admins"],
    repeatMinutes: 60,
    summary: "An interview link hit an abuse limit and new interviews or codes are being refused",
    tenantSetting: "notifications.abuseLimits",
  },
  "alerts.storm": {
    severity: "critical",
    audience: ["operator"],
    repeatMinutes: 60,
    summary: "Alerts were suppressed because the hourly limit was reached",
  },
} as const satisfies Record<string, AlertKindSpec>;

export type AlertKind = keyof typeof ALERT_KINDS;

export const ALERT_KIND_NAMES = Object.keys(ALERT_KINDS) as AlertKind[];

export function isAlertKind(value: string): value is AlertKind {
  return value in ALERT_KINDS;
}

export function alertSpec(kind: AlertKind): AlertKindSpec {
  return ALERT_KINDS[kind];
}

/**
 * The GitHub heading anchor of a kind's runbook section in `docs/OPERATIONS.md`. GitHub drops
 * everything but letters, digits, hyphens, underscores and spaces, so `job.dead_lettered` is
 * `jobdead_lettered`.
 */
export function runbookAnchor(kind: AlertKind): string {
  return kind.toLowerCase().replace(/[^a-z0-9_ -]/g, "");
}

/** The pointer an alert carries to its runbook section: a repository path, since the docs are not served. */
export function runbookRef(kind: AlertKind): string {
  return `docs/OPERATIONS.md#${runbookAnchor(kind)}`;
}

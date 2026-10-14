import {
  AlertOctagonIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleHelpIcon,
  ClockIcon,
  DatabaseBackupIcon,
  MicIcon,
  TimerIcon,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { StatTile } from "@/components/admin/StatTile";
import { DataTable } from "@/components/data/DataTable";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import type { PlatformHealth } from "@/lib/api/schemas";
import { formatBytes } from "@/lib/format";
import { cn, formatCents, formatDate, formatDuration, formatNumber, formatPercent } from "@/lib/utils";

const s = t.admin.operator.health;

type Status = "ok" | "warn" | "critical" | "unknown";

const STATUS_VARIANT = {
  ok: "success",
  warn: "warning",
  critical: "destructive",
  unknown: "secondary",
} as const;

const STATUS_ICON = {
  ok: CheckCircle2Icon,
  warn: AlertTriangleIcon,
  critical: AlertOctagonIcon,
  unknown: CircleHelpIcon,
} as const;

const STATUS_TEXT: Record<Status, string> = {
  ok: "text-success",
  warn: "text-warning",
  critical: "text-destructive",
  unknown: "text-muted-foreground",
};

/** The ceiling use of one metric as "used of max", or the word for no ceiling. */
function limit(u: PlatformHealth["tenants"][number]["utilisation"][number] | undefined): React.ReactNode {
  if (!u) return t.admin.common.dash;
  const fmt = (n: number): string => (u.metric === "storageBytes" ? formatBytes(n) : formatNumber(n));
  if (u.max <= 0)
    return (
      <span>
        {fmt(u.used)} <span className="text-muted-foreground">({s.unlimited})</span>
      </span>
    );
  const hot = u.percent !== null && u.percent >= 100;
  const warm = u.percent !== null && u.percent >= 80;
  return (
    <span className={hot ? "text-destructive font-medium" : warm ? "font-medium" : undefined}>
      {s.ofLimit(fmt(u.used), fmt(u.max))}
    </span>
  );
}

/**
 * The operator's morning page (D-222, D-377): what needs a look first, then the numbers the
 * objectives are about, every signal, the providers and each tenant. A signal that is not green is
 * an alert and is listed first with its detail; with none, the page says so in words, so "nothing
 * here" is a finding and not an empty box. Rendered on the server from one request; reloading is
 * the refresh.
 */
export function HealthPanel({ health }: { health: PlatformHealth }): React.JSX.Element {
  const worst: Status = health.signals.some((x) => x.status === "critical")
    ? "critical"
    : health.signals.some((x) => x.status === "warn")
      ? "warn"
      : "ok";
  const alerts = health.signals.filter((x) => x.status === "critical" || x.status === "warn");
  const l = health.latency;
  const slow = l.firstTokenP95Ms24h !== null && l.firstTokenP95Ms24h > l.firstTokenTargetMs;
  const SummaryIcon = STATUS_ICON[worst];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <section
        aria-label={t.ws.health.alerts}
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-5 py-4",
          worst === "critical"
            ? "bg-destructive-soft text-destructive-soft-foreground"
            : worst === "warn"
              ? "bg-warning-soft text-warning-soft-foreground"
              : "bg-success-soft text-success-soft-foreground",
        )}
      >
        <SummaryIcon className="size-6 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-[15px] font-semibold">{t.ws.health.summary[worst](alerts.length)}</p>
          <p className="text-sm opacity-90">
            {s.readAt(formatDate(health.generatedAt))}
            {health.version ? ` · ${s.release} ${health.version}` : ""}
          </p>
        </div>
        <Badge variant={STATUS_VARIANT[worst]}>{s.statusNames[worst]}</Badge>
      </section>

      {alerts.length > 0 ? (
        <Panel title={t.ws.health.alerts} description={t.ws.health.alertsBody} headingLevel={2}>
          <ul className="divide-y">
            {alerts.map((a) => {
              const Icon = STATUS_ICON[a.status];
              return (
                <li key={a.key} className="flex items-start gap-3 px-5 py-3.5">
                  <Icon className={cn("mt-0.5 size-5 shrink-0", STATUS_TEXT[a.status])} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-semibold">{s.signalNames[a.key] ?? a.key}</p>
                    <p className="text-body mt-0.5 text-sm break-words">{a.detail}</p>
                  </div>
                  <Badge variant={STATUS_VARIANT[a.status]}>{s.statusNames[a.status]}</Badge>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}

      <section aria-label={t.ws.health.objectives} className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          label={s.firstToken}
          value={l.firstTokenP95Ms24h === null ? t.admin.common.dash : formatDuration(l.firstTokenP95Ms24h)}
          hint={`${l.firstTokenP95Ms24h === null ? `${s.noData} · ` : ""}${s.target(l.firstTokenTargetMs)}${slow ? ` · ${t.ws.health.overTarget}` : ""}`}
          icon={TimerIcon}
        />
        <StatTile
          label={s.firstTokenMedian}
          value={l.firstTokenP50Ms24h === null ? t.admin.common.dash : formatDuration(l.firstTokenP50Ms24h)}
          hint={l.firstTokenP50Ms24h === null ? s.noData : undefined}
          icon={ClockIcon}
        />
        <StatTile
          label={s.voiceFirstWord}
          value={
            l.voiceFirstWordP95Ms24h === null ? t.admin.common.dash : formatDuration(l.voiceFirstWordP95Ms24h)
          }
          hint={`${l.voiceFirstWordP95Ms24h === null ? `${s.noData} · ` : ""}${s.target(l.voiceFirstWordTargetMs)}`}
          icon={MicIcon}
        />
        <StatTile
          label={s.lastBackup}
          value={health.backup.ageHours === null ? t.admin.common.dash : s.hoursAgo(health.backup.ageHours)}
          hint={
            health.backup.drill.result
              ? s.drillResult(
                  health.backup.drill.result,
                  health.backup.drill.at ? formatDate(health.backup.drill.at) : null,
                )
              : undefined
          }
          icon={DatabaseBackupIcon}
        />
      </section>

      <Panel title={s.signals} headingLevel={2}>
        {health.signals.length === 0 ? (
          <p className="text-muted-foreground px-5 py-4 text-sm">{t.ws.health.noSignals}</p>
        ) : (
          <ul className="grid gap-px sm:grid-cols-2 xl:grid-cols-3">
            {health.signals.map((sig) => {
              const Icon = STATUS_ICON[sig.status];
              return (
                <li key={sig.key} className="flex items-start gap-3 px-5 py-3.5">
                  <Icon
                    className={cn("mt-0.5 size-4 shrink-0", STATUS_TEXT[sig.status])}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-foreground flex flex-wrap items-center gap-x-2 text-sm font-medium">
                      {s.signalNames[sig.key] ?? sig.key}
                      <span className="sr-only">: {s.statusNames[sig.status]}</span>
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-[13px] break-words">{sig.detail}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <section aria-labelledby="health-providers" className="grid gap-3">
        <h2 id="health-providers" className="text-foreground text-base font-semibold tracking-tight">
          {s.providers}
        </h2>
        <DataTable
          id="health-providers-table"
          label={s.providers}
          columns={[
            { id: "provider", header: s.provider, primary: true, locked: true },
            { id: "calls", header: s.calls, align: "end" },
            { id: "failed", header: s.failed, align: "end" },
            { id: "rate", header: s.errorRate, align: "end" },
            { id: "circuit", header: s.circuit },
          ]}
          rows={health.providers.map((p) => ({
            id: p.providerId,
            label: p.name,
            cells: {
              provider: <span className="text-foreground font-medium">{p.name}</span>,
              calls: formatNumber(p.calls),
              failed: formatNumber(p.failed),
              rate: (
                <span className={p.errorRate >= 0.1 ? "text-destructive font-medium" : undefined}>
                  {formatPercent(p.errorRate)}
                </span>
              ),
              circuit: (
                <Badge
                  variant={
                    p.circuit === "closed" ? "success" : p.circuit === "open" ? "destructive" : "warning"
                  }
                >
                  {s.circuits[p.circuit]}
                </Badge>
              ),
            },
          }))}
          page={{ page: 1, limit: 100, count: health.providers.length, total: health.providers.length }}
          empty={{ title: s.noProviderCalls }}
        />
      </section>

      <section aria-labelledby="health-tenants" className="grid gap-3">
        <h2 id="health-tenants" className="text-foreground text-base font-semibold tracking-tight">
          {s.tenants}
        </h2>
        <DataTable
          id="health-tenants-table"
          label={s.tenants}
          columns={[
            { id: "tenant", header: s.tenant, primary: true, locked: true },
            { id: "status", header: t.admin.common.status },
            { id: "sessions", header: s.sessionsMonth, align: "end" },
            { id: "active", header: s.activeNow, align: "end" },
            { id: "spend", header: s.spend, align: "end" },
            { id: "storage", header: s.storage },
            { id: "voice", header: s.voice, defaultHidden: true },
            { id: "campaigns", header: s.campaigns, align: "end", defaultHidden: true },
            { id: "dead", header: s.deadLetters, align: "end" },
            { id: "last", header: s.lastActivity, defaultHidden: true },
          ]}
          rows={health.tenants.map((tn) => {
            const by = (m: string): PlatformHealth["tenants"][number]["utilisation"][number] | undefined =>
              tn.utilisation.find((u) => u.metric === m);
            return {
              id: tn.companyId,
              label: tn.name,
              cells: {
                tenant: (
                  <Link
                    href={`/admin/operator/tenants/${tn.companyId}`}
                    className="text-foreground font-medium break-words hover:underline"
                  >
                    {tn.name}
                  </Link>
                ),
                status: (
                  <Badge variant={tn.status === "active" ? "success" : "warning"}>
                    {t.admin.list.statuses[tn.status] ?? tn.status}
                  </Badge>
                ),
                sessions: limit(by("maxSessionsPerMonth")),
                active: formatNumber(tn.activeSessions),
                spend: (
                  <span>
                    {formatCents(tn.spendCents)}
                    {tn.budgetFraction !== null ? (
                      <span
                        className={
                          tn.budgetFraction >= 1
                            ? "text-destructive ml-1 font-medium"
                            : "text-muted-foreground ml-1"
                        }
                      >
                        ({formatPercent(tn.budgetFraction, 0)})
                      </span>
                    ) : null}
                  </span>
                ),
                storage: limit(by("storageBytes")),
                voice: limit(by("voiceMinutes")),
                campaigns: limit(by("maxActiveCampaigns")),
                dead:
                  tn.deadLetters24h > 0 ? (
                    <Badge variant="destructive">{tn.deadLetters24h}</Badge>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  ),
                last: (
                  <span className="text-muted-foreground">
                    {tn.lastActivityAt ? formatDate(tn.lastActivityAt) : t.admin.common.dash}
                  </span>
                ),
              },
            };
          })}
          page={{ page: 1, limit: 200, count: health.tenants.length, total: health.tenants.length }}
          empty={{ title: s.noTenants }}
        />
      </section>
    </div>
  );
}

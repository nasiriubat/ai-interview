import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { StatTile } from "@/components/admin/StatTile";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { PlatformHealth } from "@/lib/api/schemas";
import { formatCents, formatDate, formatDuration, formatNumber, formatPercent } from "@/lib/utils";

const s = t.admin.operator.health;

const STATUS_VARIANT = {
  ok: "success",
  warn: "warning",
  critical: "destructive",
  unknown: "secondary",
} as const;

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A byte count the way an operator reads storage: MB under a gigabyte, GB above. */
function bytes(n: number): string {
  return n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / MB)} MB`;
}

/** The ceiling use of one metric as "used of max", or the word for no ceiling. */
function limit(u: PlatformHealth["tenants"][number]["utilisation"][number] | undefined): React.ReactNode {
  if (!u) return t.admin.common.dash;
  const fmt = (n: number): string => (u.metric === "storageBytes" ? bytes(n) : formatNumber(n));
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
 * The operator's morning page (D-222): traffic lights for every platform signal, the latency the
 * objectives are about, provider and backup state, and a row per tenant with its use of its limits.
 * Rendered on the server from one request; reloading is the refresh.
 */
export function HealthPanel({ health }: { health: PlatformHealth }): React.JSX.Element {
  const worst = health.signals.some((x) => x.status === "critical")
    ? "critical"
    : health.signals.some((x) => x.status === "warn")
      ? "warn"
      : "ok";
  const l = health.latency;
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={STATUS_VARIANT[worst]}>{s.statusNames[worst]}</Badge>
        <p className="text-muted-foreground text-sm">
          {s.readAt(formatDate(health.generatedAt))}
          {health.version ? ` · ${s.release} ${health.version}` : ""}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={s.firstToken}
          value={l.firstTokenP95Ms24h === null ? s.noData : formatDuration(l.firstTokenP95Ms24h)}
          hint={s.target(l.firstTokenTargetMs)}
        />
        <StatTile
          label={s.firstTokenMedian}
          value={l.firstTokenP50Ms24h === null ? s.noData : formatDuration(l.firstTokenP50Ms24h)}
        />
        <StatTile
          label={s.voiceFirstWord}
          value={l.voiceFirstWordP95Ms24h === null ? s.noData : formatDuration(l.voiceFirstWordP95Ms24h)}
          hint={s.target(l.voiceFirstWordTargetMs)}
        />
        <StatTile
          label={s.lastBackup}
          value={health.backup.ageHours === null ? s.never : s.hoursAgo(health.backup.ageHours)}
          hint={
            health.backup.drill.result
              ? s.drillResult(
                  health.backup.drill.result,
                  health.backup.drill.at ? formatDate(health.backup.drill.at) : null,
                )
              : undefined
          }
        />
      </div>

      <Panel title={s.signals}>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.signal}</TableHead>
                <TableHead>{t.admin.common.status}</TableHead>
                <TableHead>{s.signals}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.signals.map((sig) => (
                <TableRow key={sig.key}>
                  <TableCell className="font-medium">{s.signalNames[sig.key] ?? sig.key}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[sig.status]}>{s.statusNames[sig.status]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{sig.detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <Panel title={s.providers}>
        {health.providers.length === 0 ? (
          <p className="text-muted-foreground px-5 py-4 text-sm">{s.noProviderCalls}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{s.provider}</TableHead>
                  <TableHead className="text-right">{s.calls}</TableHead>
                  <TableHead className="text-right">{s.failed}</TableHead>
                  <TableHead className="text-right">{s.errorRate}</TableHead>
                  <TableHead>{s.circuit}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.providers.map((p) => (
                  <TableRow key={p.providerId}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(p.calls)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(p.failed)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPercent(p.errorRate)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          p.circuit === "closed"
                            ? "success"
                            : p.circuit === "open"
                              ? "destructive"
                              : "warning"
                        }
                      >
                        {s.circuits[p.circuit]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <Panel title={s.tenants}>
        {health.tenants.length === 0 ? (
          <p className="text-muted-foreground px-5 py-4 text-sm">{s.noTenants}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{s.tenant}</TableHead>
                  <TableHead>{t.admin.common.status}</TableHead>
                  <TableHead className="text-right">{s.sessionsMonth}</TableHead>
                  <TableHead className="text-right">{s.activeNow}</TableHead>
                  <TableHead className="text-right">{s.spend}</TableHead>
                  <TableHead>{s.storage}</TableHead>
                  <TableHead>{s.voice}</TableHead>
                  <TableHead className="text-right">{s.campaigns}</TableHead>
                  <TableHead className="text-right">{s.deadLetters}</TableHead>
                  <TableHead>{s.lastActivity}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.tenants.map((tn) => {
                  const by = (m: string) => tn.utilisation.find((u) => u.metric === m);
                  return (
                    <TableRow key={tn.companyId}>
                      <TableCell className="font-medium">{tn.name}</TableCell>
                      <TableCell>
                        <Badge variant={tn.status === "active" ? "success" : "warning"}>{tn.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {limit(by("maxSessionsPerMonth"))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(tn.activeSessions)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
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
                      </TableCell>
                      <TableCell className="text-sm tabular-nums">{limit(by("storageBytes"))}</TableCell>
                      <TableCell className="text-sm tabular-nums">{limit(by("voiceMinutes"))}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {limit(by("maxActiveCampaigns"))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {tn.deadLetters24h > 0 ? (
                          <Badge variant="destructive">{tn.deadLetters24h}</Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {tn.lastActivityAt ? formatDate(tn.lastActivityAt) : t.admin.common.dash}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}

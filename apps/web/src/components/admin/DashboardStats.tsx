import type { StatsAi, StatsHealth, StatsParticipation, StatsRequirements } from "@aidp/shared";
import * as React from "react";
import { BarList } from "@/components/admin/charts/BarList";
import { LoadError } from "@/components/admin/LoadError";
import { Panel } from "@/components/admin/Panel";
import { StatTile } from "@/components/admin/StatTile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { label } from "@/lib/i18n/enums";
import { formatNumber, formatPercent } from "@/lib/utils";

export interface Segment<T> {
  data: T | null;
  error: unknown;
}

function formatBytes(bytes: number): string {
  const nf = (v: number): string => formatNumber(Math.round(v * 10) / 10);
  if (bytes < 1024 * 1024) return `${nf(bytes / 1024)} kB`;
  if (bytes < 1024 ** 3) return `${nf(bytes / 1024 ** 2)} MB`;
  return `${nf(bytes / 1024 ** 3)} GB`;
}

const DASH = (): string => t.admin.common.dash;

/**
 * The statistics of spec 07 beyond the headline tiles: participation, requirements, response
 * times and outcomes from the ledger, and health. Each panel has its own error state, so one
 * segment failing leaves the rest. Where the API withheld a figure for being derived from fewer
 * than k people, the panel says so instead of showing a dash that reads as a missing value.
 */
export function ParticipationPanel({ segment }: { segment: Segment<StatsParticipation> }): React.JSX.Element {
  const s = t.admin.dashboard.participation;
  const p = segment.data;
  if (!p) {
    return (
      <Panel title={s.title}>
        <div className="p-5">
          <LoadError error={segment.error} title={t.admin.dashboard.statsUnavailable} />
        </div>
      </Panel>
    );
  }
  const minutes = p.medianActiveSeconds === null ? null : Math.max(1, Math.round(p.medianActiveSeconds / 60));
  return (
    <section aria-label={s.title} className="grid gap-4">
      <h2 className="text-foreground text-base font-semibold tracking-tight">{s.title}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label={s.medianLength}
          value={minutes === null ? DASH() : s.minutes(minutes)}
          hint={minutes === null && p.medianSessions > 0 ? s.withheld(p.k) : s.medianLengthHint}
        />
        <StatTile
          label={s.identified}
          value={p.identified.share === null ? DASH() : formatPercent(p.identified.share, 0)}
          hint={
            p.identified.share === null
              ? s.withheld(p.k)
              : s.identifiedHint(p.identified.identified ?? 0, p.identified.anonymous ?? 0)
          }
        />
        <StatTile
          label={s.reminders}
          value={formatNumber(p.reminders.sent)}
          hint={s.remindersHint(p.reminders.invitationsReminded)}
        />
      </div>
      <Panel title={s.dropOff} description={s.dropOffBody} headingLevel={3}>
        <div className="px-5 py-5">
          {p.dropOff.unfinished === 0 ? (
            <p className="text-muted-foreground text-sm">{s.dropOffNone}</p>
          ) : (
            <BarList
              label={s.dropOff}
              items={[
                ...p.dropOff.areas.map((a) => ({
                  key: a.areaKey,
                  label: a.name,
                  value: a.sessions,
                  display: formatNumber(a.sessions),
                })),
                ...(p.dropOff.other > 0
                  ? [
                      {
                        key: "__other",
                        label: s.dropOffOther,
                        value: p.dropOff.other,
                        display: formatNumber(p.dropOff.other),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </div>
      </Panel>
    </section>
  );
}

export function RequirementsPanel({ segment }: { segment: Segment<StatsRequirements> }): React.JSX.Element {
  const s = t.admin.dashboard.requirements;
  const r = segment.data;
  if (!r) {
    return (
      <Panel title={s.title}>
        <div className="p-5">
          <LoadError error={segment.error} title={t.admin.dashboard.statsUnavailable} />
        </div>
      </Panel>
    );
  }
  const projects = Object.entries(r.projectsByStatus);
  return (
    <section aria-label={s.title} className="grid gap-4">
      <h2 className="text-foreground text-base font-semibold tracking-tight">{s.title}</h2>
      {projects.length === 0 ? (
        <p className="text-muted-foreground text-sm">{s.none}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatTile
              label={s.turns}
              value={r.turnsToSpec.median === null ? DASH() : formatNumber(r.turnsToSpec.median)}
              hint={s.turnsHint(r.turnsToSpec.sessions)}
            />
            <StatTile
              label={s.findings}
              value={r.findings.resolvedRatio === null ? DASH() : formatPercent(r.findings.resolvedRatio, 0)}
              hint={s.findingsHint(r.findings.raised, r.findings.resolved)}
            />
            <StatTile label={s.specVersions} value={formatNumber(r.specVersions)} />
          </div>
          <Panel title={s.projects} headingLevel={3}>
            <div className="px-5 py-5">
              <BarList
                label={s.projects}
                items={projects.map(([status, n]) => ({
                  key: status,
                  label: label("status", status),
                  value: n,
                  display: formatNumber(n),
                }))}
              />
            </div>
          </Panel>
        </>
      )}
    </section>
  );
}

export function LatencyPanel({ segment }: { segment: Segment<StatsAi> }): React.JSX.Element {
  const l = t.admin.dashboard.latency;
  const o = t.admin.dashboard.outcomes;
  const a = segment.data;
  if (!a) {
    return (
      <Panel title={l.title}>
        <div className="p-5">
          <LoadError error={segment.error} title={t.admin.dashboard.statsUnavailable} />
        </div>
      </Panel>
    );
  }
  return (
    <section aria-label={l.title} className="grid gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          label={o.failureRate}
          value={a.failureRate === null ? DASH() : formatPercent(a.failureRate, 1)}
          hint={o.failureHint}
        />
        <StatTile
          label={o.errorRate}
          value={a.errorRate === null ? DASH() : formatPercent(a.errorRate, 1)}
          hint={a.refusalRate === null ? undefined : `${o.refusalRate}: ${formatPercent(a.refusalRate, 1)}`}
        />
        <StatTile
          label={o.tokensPerInterview}
          value={a.tokensPerInterview === null ? DASH() : formatNumber(a.tokensPerInterview)}
          hint={o.tokensHint(a.interviews)}
        />
      </div>
      <Panel title={l.title} description={l.body} headingLevel={3}>
        {a.latency.length === 0 ? (
          <p className="text-muted-foreground px-5 py-4 text-sm">{l.empty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{l.purpose}</TableHead>
                <TableHead className="text-right">{l.calls}</TableHead>
                <TableHead className="text-right">{l.median}</TableHead>
                <TableHead className="text-right">{l.slow}</TableHead>
                <TableHead className="text-right">{l.firstToken}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.latency.map((row) => (
                <TableRow key={row.purpose}>
                  <TableCell className="font-medium">{label("purpose", row.purpose)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.calls)}</TableCell>
                  <TableCell className="text-right tabular-nums">{ms(row.fullMs.p50)}</TableCell>
                  <TableCell className="text-right tabular-nums">{ms(row.fullMs.p95)}</TableCell>
                  <TableCell className="text-muted-foreground text-right">
                    {row.firstTokenMs
                      ? `${ms(row.firstTokenMs.p50)} / ${ms(row.firstTokenMs.p95)}`
                      : l.notRecorded}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </section>
  );
}

function ms(v: number): string {
  return v < 1000 ? `${formatNumber(v)} ms` : `${formatNumber(Math.round(v / 100) / 10)} s`;
}

export function HealthPanel({ segment }: { segment: Segment<StatsHealth> }): React.JSX.Element {
  const s = t.admin.dashboard.health;
  const h = segment.data;
  if (!h) {
    return (
      <Panel title={s.title}>
        <div className="p-5">
          <LoadError error={segment.error} title={t.admin.dashboard.statsUnavailable} />
        </div>
      </Panel>
    );
  }
  return (
    <section aria-label={s.title} className="grid gap-4">
      <h2 className="text-foreground text-base font-semibold tracking-tight">{s.title}</h2>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label={s.queued} value={formatNumber(h.depth.queued)} />
        <StatTile label={s.active} value={formatNumber(h.depth.active)} />
        <StatTile label={s.failed} value={formatNumber(h.failedJobs)} hint={s.failedHint} />
        <StatTile
          label={s.storage}
          value={formatBytes(h.storage.bytes)}
          hint={
            h.storage.quotaBytes
              ? `${s.quota(formatBytes(h.storage.bytes), formatBytes(h.storage.quotaBytes))} · ${s.storageHint(h.storage.files)}`
              : s.storageHint(h.storage.files)
          }
        />
      </div>
    </section>
  );
}

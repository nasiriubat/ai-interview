import { CheckCircle2Icon, EuroIcon, MegaphoneIcon, MessagesSquareIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { BarList } from "@/components/admin/charts/BarList";
import { DailyColumns } from "@/components/admin/charts/DailyColumns";
import {
  HealthPanel,
  LatencyPanel,
  ParticipationPanel,
  RequirementsPanel,
} from "@/components/admin/DashboardStats";
import { DiscoveryTiles } from "@/components/admin/DiscoveryTiles";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { Panel } from "@/components/admin/Panel";
import { SetupChecklist } from "@/components/admin/SetupChecklist";
import { StatTile } from "@/components/admin/StatTile";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { dailySeries, dashboardNumbers } from "@/lib/admin/dashboard";
import { extractDiscoveryStats } from "@/lib/admin/discoveryStats";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";
import { label } from "@/lib/i18n/enums";
import { formatCents, formatCompact, formatDuration, formatNumber, formatPercent } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.dashboard.title };
}

const DAYS = 30;

function ranges(): { month: { from: string; to: string }; daily: { from: string; to: string } } {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const dailyStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (DAYS - 1)),
  );
  return {
    month: { from: monthStart.toISOString(), to: now.toISOString() },
    daily: { from: dailyStart.toISOString(), to: now.toISOString() },
  };
}

function shortDay(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  const api = await staffServer();
  const r = ranges();
  // The checklist is for the people who can act on it; a member is not asked, and a failure to
  // load it leaves the dashboard as it was.
  const canSetUp = me?.user.role === "admin" || me?.user.role === "platform_operator";
  const [statsR, purposeR, dailyR, onboardingR, participationR, requirementsR, aiR, healthR] =
    await Promise.allSettled([
      api.stats(),
      api.spend({ ...r.month, groupBy: "purpose" }),
      api.spend({ ...r.daily, groupBy: "day" }),
      canSetUp ? api.onboarding.get() : Promise.reject(new Error("not for members")),
      api.statsSegments.participation(),
      api.statsSegments.requirements(),
      api.statsSegments.ai(),
      // Queue depth is the platform's, so it is for the people who run things.
      canSetUp ? api.statsSegments.health() : Promise.reject(new Error("not for members")),
    ]);
  const stats = settled(statsR);
  const byPurpose = settled(purposeR);
  const daily = settled(dailyR);
  const onboarding = onboardingR.status === "fulfilled" ? onboardingR.value : null;
  const s = t.admin.dashboard;

  const n = stats.data ? dashboardNumbers(stats.data) : null;
  const discovery = stats.data ? extractDiscoveryStats(stats.data).discovery : null;

  const spent =
    byPurpose.data?.budget?.spentCents ?? byPurpose.data?.rows.reduce((a, x) => a + x.costCents, 0) ?? null;
  const limit = byPurpose.data?.budget?.limitCents ?? null;
  const series = daily.data ? dailySeries(daily.data.rows, DAYS) : null;
  const seriesTotal = series?.reduce((a, p) => a + p.costCents, 0) ?? 0;

  return (
    <>
      <PageHeader title={s.title} subtitle={s.subtitle} />
      <div className="grid gap-6">
        {onboarding ? (
          <SetupChecklist state={onboarding} resultsReady={(n?.interviews?.completed ?? 0) > 0} />
        ) : null}
        <section aria-label={s.title} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            icon={EuroIcon}
            label={s.spendTitle}
            value={formatCents(spent)}
            hint={
              limit !== null && spent !== null
                ? s.spendAgainstBudget(formatCents(spent), formatCents(limit))
                : s.noBudget
            }
          />
          <StatTile
            icon={MegaphoneIcon}
            label={s.kpi.openCampaigns}
            value={n?.campaigns ? formatNumber(n.campaigns.open) : t.admin.common.dash}
            hint={n?.campaigns ? s.kpi.ofTotal(n.campaigns.total) : undefined}
          />
          <StatTile
            icon={MessagesSquareIcon}
            label={s.kpi.activeInterviews}
            value={n?.interviews ? formatNumber(n.interviews.active) : t.admin.common.dash}
            hint={n?.interviews ? s.kpi.started(n.interviews.started) : undefined}
          />
          <StatTile
            icon={CheckCircle2Icon}
            label={s.kpi.completed}
            value={n?.interviews ? formatNumber(n.interviews.completed) : t.admin.common.dash}
            hint={
              n?.interviews?.completionRate != null
                ? s.kpi.completionRate(formatPercent(n.interviews.completionRate, 0))
                : undefined
            }
          />
        </section>

        {limit !== null && spent !== null && limit > 0 ? <BudgetBar spent={spent} limit={limit} /> : null}

        <div className="grid gap-6 lg:grid-cols-5">
          <Panel
            className="lg:col-span-3"
            title={s.dailyTitle}
            description={series ? s.dailyTotal(formatCents(seriesTotal)) : s.dailyDescription}
          >
            <div className="px-5 py-5">
              {series ? (
                <DailyColumns
                  label={`${s.dailyTitle}. ${s.dailyTotal(formatCents(seriesTotal))}`}
                  axisStart={shortDay(series[0]?.day ?? "")}
                  axisEnd={shortDay(series[series.length - 1]?.day ?? "")}
                  points={series.map((p) => ({
                    day: p.day,
                    value: p.costCents,
                    tooltip: s.dailyTooltip(shortDay(p.day), formatCents(p.costCents), p.calls),
                  }))}
                />
              ) : (
                <LoadError error={daily.error} />
              )}
            </div>
          </Panel>

          <Panel className="lg:col-span-2" title={s.funnelTitle} description={s.funnelDescription}>
            <div className="px-5 py-5">
              {n?.interviews ? (
                <BarList
                  label={s.funnelTitle}
                  sort={false}
                  // Open links bring people in without an invitation, so "invited" is only the top of
                  // the funnel when invitations were actually sent; otherwise it reads as a 0 that
                  // everyone else somehow got past.
                  items={[
                    ...(n.interviews.invited > 0
                      ? [{ key: "invited", label: s.funnel.invited, value: n.interviews.invited }]
                      : []),
                    { key: "started", label: s.funnel.started, value: n.interviews.started },
                    { key: "active", label: s.funnel.active, value: n.interviews.active },
                    { key: "completed", label: s.funnel.completed, value: n.interviews.completed },
                  ].map((i) => ({ ...i, display: formatNumber(i.value) }))}
                />
              ) : (
                <LoadError error={stats.error} title={s.statsUnavailable} />
              )}
            </div>
          </Panel>
        </div>

        <div className="grid gap-6 lg:grid-cols-5">
          <Panel
            className="lg:col-span-3"
            title={s.spendByPurpose}
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/budgets">{s.viewAll}</Link>
              </Button>
            }
          >
            <div className="px-5 py-5">
              {byPurpose.data ? (
                byPurpose.data.rows.length > 0 ? (
                  <BarList
                    label={s.spendByPurpose}
                    items={byPurpose.data.rows.map((row) => ({
                      key: row.key,
                      label: label("purpose", row.key),
                      value: row.costCents,
                      display: formatCents(row.costCents),
                      detail: `${formatNumber(row.calls)} ${s.calls.toLowerCase()}`,
                    }))}
                  />
                ) : (
                  <p className="text-muted-foreground text-sm">{s.noStats}</p>
                )
              ) : (
                <LoadError error={byPurpose.error} />
              )}
            </div>
          </Panel>

          <Panel className="lg:col-span-2" title={s.aiTitle}>
            {n?.ai ? (
              <dl className="divide-y text-[13px]">
                <Metric label={s.ai.calls} value={formatNumber(n.ai.calls)} />
                <Metric
                  label={s.ai.tokensIn}
                  value={formatCompact(n.ai.inputTokens)}
                  title={formatNumber(n.ai.inputTokens)}
                />
                <Metric
                  label={s.ai.tokensOut}
                  value={formatCompact(n.ai.outputTokens)}
                  title={formatNumber(n.ai.outputTokens)}
                />
                <Metric
                  label={s.ai.cacheHit}
                  value={formatPercent(n.ai.cacheHitRate)}
                  title={s.ai.cacheHitHint}
                />
                <Metric label={s.ai.latency} value={formatDuration(n.ai.avgLatencyMs)} />
                <Metric
                  label={s.ai.errors}
                  value={formatPercent(n.ai.errorRate)}
                  tone={n.ai.errorRate !== null && n.ai.errorRate > 0.05 ? "warning" : undefined}
                />
              </dl>
            ) : (
              <div className="p-5">
                <LoadError error={stats.error} title={s.statsUnavailable} />
              </div>
            )}
          </Panel>
        </div>

        {discovery ? <DiscoveryTiles discovery={discovery} /> : null}

        <ParticipationPanel segment={settled(participationR)} />
        <RequirementsPanel segment={settled(requirementsR)} />
        <LatencyPanel segment={settled(aiR)} />
        {canSetUp ? <HealthPanel segment={settled(healthR)} /> : null}
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  title,
  tone,
}: {
  label: string;
  value: string;
  title?: string | undefined;
  tone?: "warning" | undefined;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3" title={title}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          tone === "warning"
            ? "text-warning-soft-foreground font-semibold tabular-nums"
            : "text-foreground font-medium tabular-nums"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function BudgetBar({ spent, limit }: { spent: number; limit: number }): React.JSX.Element {
  const pct = Math.min(100, Math.round((spent / limit) * 100));
  const tone = pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-warning" : "bg-primary";
  return (
    <div className="bg-card shadow-card grid gap-2 rounded-lg px-5 py-4">
      <div className="flex justify-between text-[13px]">
        <span className="text-foreground font-medium">{t.admin.budgets.title}</span>
        <span className="text-muted-foreground tabular-nums">
          {t.admin.dashboard.spendAgainstBudget(formatCents(spent), formatCents(limit))} · {pct}%
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t.admin.budgets.title}
        className="bg-muted h-2 overflow-hidden rounded-full"
      >
        <div className={`${tone} h-full rounded-full`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

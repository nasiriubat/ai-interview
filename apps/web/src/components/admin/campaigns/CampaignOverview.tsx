import Link from "next/link";
import * as React from "react";
import { AnalysisCard } from "@/components/admin/campaigns/AnalysisCard";
import { CampaignLink } from "@/components/admin/campaigns/CampaignLink";
import { LoadError } from "@/components/admin/LoadError";
import { MeterBar } from "@/components/admin/MeterBar";
import { Panel } from "@/components/admin/Panel";
import { StatTile } from "@/components/admin/StatTile";
import { EnumLabel } from "@/components/common/EnumLabel";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { Analysis, Campaign } from "@/lib/api/schemas";
import { formatCents } from "@/lib/utils";

/** What the overview needs that is not on the campaign itself; each part may have failed to load. */
export interface OverviewData {
  latestAnalysis: Analysis | undefined;
  /** Why the analysis could not be loaded, when it could not. */
  analysisError: unknown;
  /** Spend on this campaign and its budget, when the API answered. */
  spend: { spentCents: number; limitCents: number | null } | null;
  /** The template's own names for coverage areas, for the drop-off table. */
  areaNames: Record<string, string>;
}

/**
 * The first section of a campaign: how to share it, how far it has got, what the analysis can do
 * now and what it has cost (D-237). Everything here answers "do I need to do something?".
 */
export function CampaignOverview({
  campaign,
  data,
}: {
  campaign: Campaign;
  data: OverviewData;
}): React.JSX.Element {
  const s = t.admin.campaigns;
  const stats = campaign.stats;
  const completed = stats?.completed ?? 0;
  const threshold = campaign.completionThreshold ?? 0;
  const dropOff = Object.entries(stats?.dropOffByArea ?? {});
  const spend = data.spend;
  return (
    <div className="grid gap-6">
      <CampaignLink name={campaign.name} url={campaign.link?.url} status={campaign.status} />

      <section aria-label={s.statsTitle} className="grid gap-3">
        <div className="grid grid-cols-3 gap-3">
          <StatTile label={s.invited} value={stats?.invited ?? t.admin.common.dash} />
          <StatTile label={s.started} value={stats?.started ?? t.admin.common.dash} />
          <StatTile label={s.completed} value={stats?.completed ?? t.admin.common.dash} />
        </div>
        {threshold > 0 ? (
          <div className="bg-card shadow-card grid gap-2 rounded-lg px-5 py-4">
            <div className="flex flex-wrap justify-between gap-x-4 text-[13px]">
              <span className="text-foreground font-medium">{s.thresholdTitle}</span>
              <span className="text-muted-foreground tabular-nums">
                {s.thresholdValue(completed, threshold)}
              </span>
            </div>
            <MeterBar
              value={completed}
              max={threshold}
              label={s.thresholdTitle}
              valueText={s.thresholdValue(completed, threshold)}
            />
            <p className="text-muted-foreground text-xs">
              {completed >= threshold ? s.thresholdMet : s.thresholdMore(threshold - completed)}
            </p>
          </div>
        ) : null}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {data.analysisError ? (
          <LoadError error={data.analysisError} />
        ) : (
          <AnalysisCard
            campaignId={campaign.id}
            latest={data.latestAnalysis}
            completed={completed}
            threshold={threshold}
          />
        )}

        <Panel title={s.spendTitle}>
          <div className="grid gap-2 px-5 py-4 text-sm">
            {spend === null ? (
              <p className="text-muted-foreground">{s.spendUnavailable}</p>
            ) : spend.limitCents !== null && spend.limitCents > 0 ? (
              <>
                <p className="tabular-nums">
                  {s.spendOf(formatCents(spend.spentCents), formatCents(spend.limitCents))}
                </p>
                <MeterBar
                  tone="spend"
                  value={spend.spentCents}
                  max={spend.limitCents}
                  label={s.spendTitle}
                  valueText={s.spendOf(formatCents(spend.spentCents), formatCents(spend.limitCents))}
                />
              </>
            ) : (
              <>
                <p>{s.spendNoBudget(formatCents(spend.spentCents))}</p>
                <div>
                  <Button asChild variant="outline" size="sm">
                    <Link href="/admin/budgets">{s.spendSetBudget}</Link>
                  </Button>
                </div>
              </>
            )}
          </div>
        </Panel>
      </div>

      {dropOff.length > 0 ? (
        <Panel title={s.dropOff}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.admin.templates.fields.areaName}</TableHead>
                <TableHead className="text-right">{s.dropOff}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dropOff.map(([k, v]) => (
                <TableRow key={k}>
                  <TableCell>{data.areaNames[k] ?? <EnumLabel kind="coverageArea" value={k} />}</TableCell>
                  <TableCell className="text-right tabular-nums">{v}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      ) : null}
    </div>
  );
}

"use client";

import { FACTOR_KEYS, isNotAi, SOLUTION_CLASSES, type SolutionClass } from "@aidp/shared";
import {
  ClockIcon,
  FileTextIcon,
  LayersIcon,
  MessagesSquareIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import * as React from "react";
import { ClassBadge } from "./ClassBadge";
import { ChartPanel } from "@/components/admin/charts/ChartPanel";
import { HeatMatrix } from "@/components/admin/charts/HeatMatrix";
import { CLASS_COLOR } from "@/components/admin/charts/palette";
import { StackedBar } from "@/components/admin/charts/StackedBar";
import { Panel } from "@/components/admin/Panel";
import { StatTile } from "@/components/admin/StatTile";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { effectiveClass, effectiveFactors, effectiveTitle } from "@/lib/analysis/rank";
import type { Analysis, Opportunity } from "@/lib/api/schemas";
import { formatNumber } from "@/lib/utils";

const TOP = 8;

/**
 * The results at a glance (D-371): what the analysis covered, what kind of solutions came out,
 * which opportunities lead and how they score on each factor. Each chart has a table view of the
 * same numbers. Only opportunities that are not dismissed are counted, so the overview agrees with
 * the list and the report.
 */
export function OverviewTab({
  analysis,
  opportunities,
  onShowOpportunities,
  onOpen,
}: {
  analysis: Analysis;
  opportunities: readonly Opportunity[];
  onShowOpportunities: () => void;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  const s = t.admin.results;
  const w = t.ws.overview;
  const stats = analysis.stats;
  const live = opportunities.filter((o) => o.status !== "dismissed");
  const ranked = [...live].sort((a, b) => b.rankScore - a.rankScore);
  const top = ranked.slice(0, TOP);

  const byClass = SOLUTION_CLASSES.map((c: SolutionClass) => {
    const of = live.filter((o) => effectiveClass(o) === c);
    return {
      key: c,
      label: s.classes[c],
      value: of.length,
      minutes: of.reduce((a, o) => a + o.stats.minutesPerWeekTotal, 0),
      color: CLASS_COLOR[c],
    };
  });
  const notAi = live.filter((o) => isNotAi(effectiveClass(o)));
  const totalMinutes = live.reduce((a, o) => a + o.stats.minutesPerWeekTotal, 0);
  const maxMinutes = Math.max(1, ...byClass.map((c) => c.minutes));

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <section
        aria-label={s.stats.title}
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 max-md:[&>*:last-child]:col-span-2"
      >
        <StatTile label={s.stats.sessions} value={formatNumber(stats.sessions)} icon={MessagesSquareIcon} />
        <StatTile label={s.stats.facts} value={formatNumber(stats.facts)} icon={FileTextIcon} />
        <StatTile label={s.stats.clusters} value={formatNumber(stats.clusters)} icon={LayersIcon} />
        <StatTile label={s.stats.participants} value={formatNumber(stats.participants)} icon={UsersIcon} />
        <StatTile
          label={w.hoursPerWeek}
          value={formatNumber(Math.round(totalMinutes / 60))}
          hint={w.hoursHint}
          icon={ClockIcon}
        />
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-2">
        <ChartPanel
          id="chart-classes"
          title={w.classesTitle}
          description={w.classesBody}
          chart={
            <StackedBar
              segments={byClass.map((c) => ({ key: c.key, label: c.label, value: c.value, color: c.color }))}
              label={w.classesTitle}
            />
          }
          table={
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.admin.dashboard.class}</TableHead>
                  <TableHead className="text-right">{w.count}</TableHead>
                  <TableHead className="text-right">{s.card.minutesPerWeek}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byClass.map((c) => (
                  <TableRow key={c.key}>
                    <TableCell>{c.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.value}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(c.minutes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          }
        />

        <ChartPanel
          id="chart-minutes"
          title={w.minutesTitle}
          description={w.minutesBody}
          chart={
            <ul aria-label={w.minutesTitle} className="grid gap-3">
              {byClass.map((c) => (
                <li
                  key={c.key}
                  className="grid grid-cols-[7.5rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-[13px]"
                >
                  <span className="text-foreground truncate">{c.label}</span>
                  <span aria-hidden="true" className="bg-muted h-2.5 overflow-hidden rounded-full">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${String(c.minutes > 0 ? Math.max(2, (c.minutes / maxMinutes) * 100) : 0)}%`,
                        backgroundColor: c.color,
                      }}
                    />
                  </span>
                  <span className="text-foreground text-right font-medium tabular-nums">
                    {formatNumber(c.minutes)}
                  </span>
                </li>
              ))}
            </ul>
          }
        />
      </div>

      <ChartPanel
        id="chart-top"
        title={w.topTitle(top.length)}
        description={w.topBody}
        actions={
          <Button variant="outline" size="sm" onClick={onShowOpportunities}>
            {w.seeAll}
          </Button>
        }
        chart={
          top.length === 0 ? (
            <p className="text-muted-foreground text-sm">{s.empty}</p>
          ) : (
            <HeatMatrix
              caption={w.matrixCaption}
              corner={t.admin.dashboard.opportunity}
              columns={FACTOR_KEYS.map((k) => ({ key: k, label: t.ws.factorsShort[k], title: s.factors[k] }))}
              rows={top.map((o) => {
                const f = effectiveFactors(o);
                return {
                  key: o.id,
                  label: (
                    <button
                      type="button"
                      className="hover:text-primary text-left hover:underline"
                      onClick={() => {
                        onOpen(o.id);
                      }}
                    >
                      {effectiveTitle(o)}
                    </button>
                  ),
                  detail: `${s.classes[effectiveClass(o)]} · ${String(Math.round(o.rankScore))}`,
                  cells: FACTOR_KEYS.map((k) => ({ value: f[k].score })),
                };
              })}
              min={1}
              max={5}
            />
          )
        }
      />

      <Panel
        id="not-ai-summary"
        title={s.notAi.title}
        description={s.notAi.body}
        actions={
          notAi.length > 0 ? (
            <Button variant="outline" size="sm" onClick={onShowOpportunities}>
              {w.seeAll}
            </Button>
          ) : null
        }
      >
        {notAi.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-3 px-5 py-4 text-sm">
            <SparklesIcon className="size-4 shrink-0" aria-hidden="true" />
            {w.noneNotAi}
          </div>
        ) : (
          <ul className="divide-y">
            {notAi.slice(0, 4).map((o) => (
              <li key={o.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-5 py-3 text-sm">
                <button
                  type="button"
                  className="hover:text-primary min-w-0 flex-1 basis-60 text-left font-medium hover:underline"
                  onClick={() => {
                    onOpen(o.id);
                  }}
                >
                  {effectiveTitle(o)}
                </button>
                <ClassBadge solutionClass={effectiveClass(o)} />
                {o.whyNotAi ? (
                  <p className="text-muted-foreground w-full text-[13px] leading-relaxed">{o.whyNotAi}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { StatTile } from "@/components/admin/StatTile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { Stats } from "@/lib/api/schemas";
import { formatNumber, humanize } from "@/lib/utils";

const GROUP_LABELS: Record<string, string> = t.admin.dashboard.group;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function formatValue(v: unknown): string {
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "string" || typeof v === "boolean") return String(v);
  return "–";
}

/**
 * `/stats` is not spelled out in the contract, so the dashboard renders whatever groups
 * of numbers come back: scalars as tiles, nested records (for example drop-off by area)
 * as small tables.
 */
export function StatsGroups({ stats }: { stats: Stats }): React.JSX.Element {
  const groups = Object.entries(stats).filter(([, v]) => isRecord(v));
  const scalars = Object.entries(stats).filter(([, v]) => !isRecord(v));
  if (groups.length === 0 && scalars.length === 0) {
    return <p className="text-muted-foreground text-sm">{t.admin.dashboard.noStats}</p>;
  }
  const sections: [string, Record<string, unknown>][] = [
    ...(scalars.length > 0
      ? ([["", Object.fromEntries(scalars)]] as [string, Record<string, unknown>][])
      : []),
    ...groups.map(([k, v]) => [k, v as Record<string, unknown>] as [string, Record<string, unknown>]),
  ];
  return (
    <div className="grid gap-6">
      {sections.map(([name, values]) => {
        const tiles = Object.entries(values).filter(([, v]) => !isRecord(v) && !Array.isArray(v));
        const tables = Object.entries(values).filter(([, v]) => isRecord(v));
        return (
          <section
            key={name || "root"}
            aria-label={name ? (GROUP_LABELS[name] ?? humanize(name)) : undefined}
          >
            {name ? (
              <h2 className="text-foreground mb-3 text-base font-semibold tracking-tight">
                {GROUP_LABELS[name] ?? humanize(name)}
              </h2>
            ) : null}
            {tiles.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {tiles.map(([k, v]) => (
                  <StatTile key={k} label={humanize(k)} value={formatValue(v)} />
                ))}
              </div>
            ) : null}
            {tables.map(([k, v]) => (
              <Panel key={k} title={humanize(k)} headingLevel={3} className="mt-3">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{humanize(k)}</TableHead>
                      <TableHead className="text-right">{t.admin.common.status}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(v as Record<string, unknown>).map(([rk, rv]) => (
                      <TableRow key={rk}>
                        <TableCell>{humanize(rk)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatValue(rv)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Panel>
            ))}
          </section>
        );
      })}
    </div>
  );
}

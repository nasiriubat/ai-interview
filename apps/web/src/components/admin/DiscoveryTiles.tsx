import { SOLUTION_CLASSES, type SolutionClass } from "@aidp/shared";
import Link from "next/link";
import * as React from "react";
import { ClassBadge, RankMeter } from "@/components/admin/results/ClassBadge";
import { StatTile } from "@/components/admin/StatTile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { DiscoveryStats } from "@/lib/admin/discoveryStats";

function isSolutionClass(v: string | undefined): v is SolutionClass {
  return v !== undefined && (SOLUTION_CLASSES as readonly string[]).includes(v);
}

/** Dashboard tiles for discovery results; rendered only when `/stats` carries the data. */
export function DiscoveryTiles({ discovery }: { discovery: DiscoveryStats }): React.JSX.Element {
  const s = t.admin.dashboard;
  return (
    <section aria-label={s.discoveryTitle} className="grid gap-4">
      <h2 className="text-sm font-medium">{s.discoveryTitle}</h2>
      {discovery.byClass ? (
        <div aria-label={s.byClass} className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {SOLUTION_CLASSES.map((c) => (
            <StatTile key={c} label={t.admin.results.classes[c]} value={discovery.byClass?.[c] ?? 0} />
          ))}
        </div>
      ) : null}
      {discovery.top ? (
        <div className="rounded-lg border">
          <h3 className="border-b px-3 py-2 text-xs font-medium">{s.topByRank}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.opportunity}</TableHead>
                <TableHead>{s.campaign}</TableHead>
                <TableHead>{s.class}</TableHead>
                <TableHead>{s.rank}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {discovery.top.map((o, i) => (
                <TableRow key={o.id ?? i}>
                  <TableCell className="font-medium">
                    {o.campaignId ? (
                      <Link href={`/admin/campaigns/${o.campaignId}/results`} className="hover:underline">
                        {o.title}
                      </Link>
                    ) : (
                      o.title
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {o.campaignName ?? o.campaignId ?? t.admin.common.dash}
                  </TableCell>
                  <TableCell>
                    {isSolutionClass(o.solutionClass) ? (
                      <ClassBadge solutionClass={o.solutionClass} />
                    ) : (
                      t.admin.common.dash
                    )}
                  </TableCell>
                  <TableCell>
                    <RankMeter score={o.rankScore} compact />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </section>
  );
}

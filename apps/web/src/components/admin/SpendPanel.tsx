import * as React from "react";
import { StatTile } from "@/components/admin/StatTile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { Spend } from "@/lib/api/schemas";
import { formatCents, formatNumber, humanize } from "@/lib/utils";

export function SpendPanel({ spend, title }: { spend: Spend; title: string }): React.JSX.Element {
  const limit = spend.budget?.limitCents ?? null;
  const spent = spend.budget?.spentCents ?? spend.rows.reduce((a, r) => a + r.costCents, 0);
  const pct = limit && limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : null;
  return (
    <section aria-label={title} className="grid gap-3">
      <h2 className="text-sm font-medium">{title}</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label={t.admin.dashboard.spendTitle}
          value={formatCents(spent)}
          hint={
            limit !== null
              ? t.admin.dashboard.spendAgainstBudget(formatCents(spent), formatCents(limit))
              : t.admin.dashboard.noBudget
          }
        />
        <StatTile
          label={t.admin.dashboard.calls}
          value={formatNumber(spend.rows.reduce((a, r) => a + r.calls, 0))}
        />
        <StatTile
          label={t.admin.dashboard.tokens}
          value={formatNumber(spend.rows.reduce((a, r) => a + r.tokens, 0))}
        />
        {pct !== null ? (
          <StatTile
            label={t.admin.budgets.title}
            value={`${pct}%`}
            hint={t.admin.budgets.spentSoFar(formatCents(spent), formatCents(limit))}
          />
        ) : null}
      </div>
      {pct !== null ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t.admin.dashboard.spendTitle}
          className="bg-muted h-2 w-full overflow-hidden rounded-full"
        >
          <div
            className={
              pct >= 100 ? "h-full bg-red-600" : pct >= 80 ? "h-full bg-amber-500" : "bg-primary h-full"
            }
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {spend.rows.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.admin.dashboard.spendByPurpose}</TableHead>
              <TableHead className="text-right">{t.admin.dashboard.calls}</TableHead>
              <TableHead className="text-right">{t.admin.dashboard.tokens}</TableHead>
              <TableHead className="text-right">{t.admin.dashboard.cost}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spend.rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell>{humanize(r.key)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.calls)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(r.tokens)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCents(r.costCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </section>
  );
}

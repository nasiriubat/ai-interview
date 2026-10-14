import { CalendarCheckIcon, CoinsIcon, HardDriveIcon, MessagesSquareIcon, ZapIcon } from "lucide-react";
import * as React from "react";
import { BarList } from "@/components/admin/charts/BarList";
import { MeterBar } from "@/components/admin/MeterBar";
import { Panel } from "@/components/admin/Panel";
import { StatTile } from "@/components/admin/StatTile";
import { EnumLabel } from "@/components/common/EnumLabel";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import type { Statement } from "@/lib/api/schemas";
import { formatBytes } from "@/lib/format";
import { label } from "@/lib/i18n/enums";
import { formatCents, formatNumber } from "@/lib/utils";

/**
 * One frozen statement (D-376): the total and what it is made of, the lines an invoice would carry,
 * the budgets that were reached, and the month's activity. Figures that are our estimate rather
 * than the provider's report are marked as such, so the total is never read as more exact than it is.
 */
export function StatementView({ statement: st }: { statement: Statement }): React.JSX.Element {
  const s = t.ws.statements;
  const byPurpose = Object.entries(st.totals.byPurpose).map(([k, v]) => ({
    key: k,
    label: label("purpose", k),
    value: v,
    display: formatCents(v),
  }));
  const byProvider = Object.entries(st.totals.byProvider).map(([k, v]) => ({
    key: k,
    label: k,
    value: v,
    display: formatCents(v),
  }));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <section aria-label={s.totals} className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          label={s.total}
          value={formatCents(st.totals.costCents)}
          hint={
            st.totals.estimatedCents > 0
              ? s.ofWhichEstimated(formatCents(st.totals.estimatedCents))
              : s.allReported
          }
          icon={CoinsIcon}
        />
        <StatTile label={s.calls} value={formatNumber(st.totals.calls)} icon={ZapIcon} />
        <StatTile
          label={s.sessions}
          value={`${formatNumber(st.counts.sessionsCompleted)} / ${formatNumber(st.counts.sessionsStarted)}`}
          hint={s.participants(st.counts.participants)}
          icon={MessagesSquareIcon}
        />
        <StatTile
          label={s.storage}
          value={formatBytes(st.counts.storageBytes)}
          hint={s.voiceMinutes(st.counts.voiceMinutes)}
          icon={HardDriveIcon}
        />
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-2">
        <Panel title={s.byPurpose} headingLevel={2}>
          <div className="px-5 py-4">
            {byPurpose.length > 0 ? (
              <BarList items={byPurpose} label={s.byPurpose} />
            ) : (
              <p className="text-muted-foreground text-sm">{s.noSpend}</p>
            )}
          </div>
        </Panel>
        <Panel title={s.byProvider} headingLevel={2}>
          <div className="px-5 py-4">
            {byProvider.length > 0 ? (
              <BarList items={byProvider} label={s.byProvider} />
            ) : (
              <p className="text-muted-foreground text-sm">{s.noSpend}</p>
            )}
          </div>
        </Panel>
      </div>

      <Panel title={s.lines} description={s.linesBody} headingLevel={2}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.provider}</TableHead>
              <TableHead>{s.model}</TableHead>
              <TableHead>{s.purpose}</TableHead>
              <TableHead className="text-right">{s.calls}</TableHead>
              <TableHead className="text-right">{s.tokens}</TableHead>
              <TableHead className="text-right">{s.cost}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {st.lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground py-6 text-center">
                  {s.noSpend}
                </TableCell>
              </TableRow>
            ) : (
              st.lines.map((l, i) => (
                <TableRow key={`${l.providerId}-${l.model}-${l.purpose}-${String(i)}`}>
                  <TableCell className="font-medium">{l.providerName}</TableCell>
                  <TableCell className="font-mono text-xs break-all">{l.model}</TableCell>
                  <TableCell>
                    <EnumLabel kind="purpose" value={l.purpose} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(l.calls)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(l.inputTokens + l.cacheReadTokens + l.cacheWriteTokens + l.outputTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCents(l.costCents)}
                    {l.estimatedCents > 0 ? (
                      <span className="text-muted-foreground block text-xs">{s.estimatedMark}</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Panel>

      <Panel title={s.budgets} description={s.budgetsBody} headingLevel={2}>
        {st.totals.budgets.length === 0 ? (
          <p className="text-muted-foreground px-5 py-4 text-sm">{s.noBudgets}</p>
        ) : (
          <ul className="divide-y">
            {st.totals.budgets.map((b) => (
              <li
                key={`${b.scope}-${b.scopeId}`}
                className="grid gap-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-center"
              >
                <span className="min-w-0">
                  <span className="text-foreground block text-sm font-medium break-words">
                    {b.name ?? label("budgetScope", b.scope)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {label("budgetScope", b.scope)} ·{" "}
                    {b.period === "month" ? t.admin.budgets.periods.month : t.admin.budgets.periods.total}
                  </span>
                </span>
                <span className="grid gap-1">
                  <span className="text-xs tabular-nums">
                    {t.admin.budgets.spentSoFar(formatCents(b.spentCents), formatCents(b.limitCents))}
                  </span>
                  {b.limitCents > 0 ? (
                    <MeterBar
                      tone="spend"
                      value={b.spentCents}
                      max={b.limitCents}
                      label={b.name ?? b.scopeId}
                      valueText={t.admin.budgets.spentSoFar(
                        formatCents(b.spentCents),
                        formatCents(b.limitCents),
                      )}
                    />
                  ) : null}
                </span>
                {b.hit ? <Badge variant="warning">{s.reached}</Badge> : <span />}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <CalendarCheckIcon className="size-3.5" aria-hidden="true" />
        {s.frozenNote}
      </p>
    </div>
  );
}

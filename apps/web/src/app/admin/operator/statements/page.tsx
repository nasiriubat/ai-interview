import { FileSpreadsheetIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatTile } from "@/components/admin/StatTile";
import { DataTable } from "@/components/data/DataTable";
import { DownloadButton } from "@/components/data/DownloadButton";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { errorMessage } from "@/lib/api/errors";
import type { Statement } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";
import { formatMonth, previousMonth } from "@/lib/format";
import { cn, formatCents, formatNumber } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).ws.statements.operatorTitle };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The last twelve months, newest first, ending with the one that has just been frozen. */
function recentMonths(): string[] {
  const out: string[] = [];
  let m = previousMonth();
  for (let i = 0; i < 12; i++) {
    out.push(m);
    const [y, mo] = m.split("-").map(Number) as [number, number];
    m = new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
  }
  return out;
}

/**
 * Every tenant's frozen statement for one month, the operator's invoicing sheet (D-224, D-376).
 * The month is a link, not a form: the choices are the twelve months that can have a statement.
 */
export default async function OperatorStatementsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const sp = await searchParams;
  const months = recentMonths();
  const requested = typeof sp.month === "string" ? sp.month : undefined;
  const month = requested && months.includes(requested) ? requested : (months[0] ?? previousMonth());
  const api = await staffServer();
  let statements: Statement[] = [];
  let error: string | undefined;
  try {
    statements = (await api.operator.statements(month)).statements;
  } catch (e) {
    error = errorMessage(e, t.app.unknownError);
  }
  const s = t.ws.statements;
  const total = statements.reduce((a, st) => a + st.totals.costCents, 0);
  const estimated = statements.reduce((a, st) => a + st.totals.estimatedCents, 0);
  return (
    <>
      <PageHeader
        title={s.operatorTitle}
        subtitle={s.operatorSubtitle}
        actions={
          statements.length > 0 ? (
            <DownloadButton
              label={`CSV: ${formatMonth(month)}`}
              text={s.downloadCsv}
              variant="outline"
              path={`/api/staff/operator/statements/${month}?format=csv`}
              fallbackName={`statements-${month}.csv`}
              what="CSV"
            />
          ) : undefined
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <nav aria-label={s.month} className="flex flex-wrap gap-1.5">
          {months.map((m) => (
            <Link
              key={m}
              href={`/admin/operator/statements?month=${m}`}
              aria-current={m === month ? "page" : undefined}
              className={cn(
                "rounded-full px-3 py-1 text-[13px] font-medium transition-colors",
                m === month
                  ? "bg-accent text-accent-foreground shadow-[0_0_0_1px_var(--primary)]"
                  : "bg-muted text-body hover:bg-secondary-hover",
              )}
            >
              {formatMonth(m)}
            </Link>
          ))}
        </nav>
        <section aria-label={s.totals} className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <StatTile
            label={s.total}
            value={formatCents(total)}
            hint={s.ofWhichEstimated(formatCents(estimated))}
          />
          <StatTile label={s.tenantsCount} value={formatNumber(statements.length)} />
          <StatTile
            label={s.calls}
            value={formatNumber(statements.reduce((a, st) => a + st.totals.calls, 0))}
          />
        </section>
        <DataTable
          id="operator-statements"
          label={s.operatorTitle}
          error={error}
          columns={[
            { id: "tenant", header: t.admin.operator.name, primary: true, locked: true },
            { id: "cost", header: s.cost, align: "end" },
            { id: "calls", header: s.calls, align: "end" },
            { id: "sessions", header: s.sessions, align: "end" },
            { id: "budgets", header: s.budgetsHit },
          ]}
          rows={statements.map((st) => {
            const hit = st.totals.budgets.filter((b) => b.hit).length;
            return {
              id: st.companyId,
              label: st.companyId,
              cells: {
                tenant: (
                  <Link
                    href={`/admin/operator/tenants/${st.companyId}`}
                    className="text-foreground font-mono text-xs hover:underline"
                  >
                    {st.companyId}
                  </Link>
                ),
                cost: (
                  <span>
                    {formatCents(st.totals.costCents)}
                    {st.totals.estimatedCents > 0 ? (
                      <span className="text-muted-foreground block text-xs">
                        {s.ofWhichEstimated(formatCents(st.totals.estimatedCents))}
                      </span>
                    ) : null}
                  </span>
                ),
                calls: formatNumber(st.totals.calls),
                sessions: `${formatNumber(st.counts.sessionsCompleted)} / ${formatNumber(st.counts.sessionsStarted)}`,
                budgets:
                  hit > 0 ? (
                    <Badge variant="warning">{s.budgetsReached(hit)}</Badge>
                  ) : (
                    <span className="text-muted-foreground">{s.noneReached}</span>
                  ),
              },
            };
          })}
          page={{ page: 1, limit: 500, count: statements.length, total: statements.length }}
          empty={{
            icon: <FileSpreadsheetIcon className="size-5" aria-hidden="true" />,
            title: s.operatorEmptyTitle,
            description: s.operatorEmpty(formatMonth(month)),
          }}
        />
      </div>
    </>
  );
}

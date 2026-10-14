import { CoinsIcon, EyeIcon, FileSpreadsheetIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { PageHeader } from "@/components/admin/PageHeader";
import { DataTable } from "@/components/data/DataTable";
import { DownloadButton } from "@/components/data/DownloadButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { errorMessage } from "@/lib/api/errors";
import type { Statement } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";
import { formatMonth } from "@/lib/format";
import { formatCents, formatDate, formatNumber } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).ws.statements.title };
}

/**
 * The organization's monthly statements (D-224, D-376): what each month cost, frozen on the 1st so
 * the figures survive the retention of the calls under them. Administrators only; the API answers
 * 403 to members and the page says so rather than showing an empty table.
 */
export default async function StatementsPage(): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const api = await staffServer();
  let statements: Statement[] = [];
  let error: string | undefined;
  try {
    statements = (await api.statements.list()).sort((a, b) => b.month.localeCompare(a.month));
  } catch (e) {
    error = errorMessage(e, t.app.unknownError);
  }
  const s = t.ws.statements;
  return (
    <>
      <PageHeader
        title={s.title}
        subtitle={s.subtitle}
        secondaryActions={
          <Button asChild variant="outline">
            <Link href="/admin/budgets">
              <CoinsIcon /> {t.admin.budgets.title}
            </Link>
          </Button>
        }
      />
      <DataTable
        id="statements"
        label={s.title}
        error={error}
        columns={[
          { id: "month", header: s.month, primary: true, locked: true },
          { id: "cost", header: s.cost, align: "end" },
          { id: "calls", header: s.calls, align: "end" },
          { id: "sessions", header: s.sessions, align: "end" },
          { id: "budgets", header: s.budgetsHit },
          { id: "generated", header: s.generated },
        ]}
        rows={statements.map((st) => {
          const hit = st.totals.budgets.filter((b) => b.hit).length;
          return {
            id: st.month,
            label: formatMonth(st.month),
            cells: {
              month: (
                <Link
                  href={`/admin/budgets/statements/${st.month}`}
                  className="text-foreground font-medium hover:underline"
                >
                  {formatMonth(st.month)}
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
              generated: (
                <span className="text-muted-foreground">{formatDate(st.generatedAt ?? undefined)}</span>
              ),
            },
            actions: (
              <RowActions>
                <IconButton
                  label={`${t.admin.actions.view}: ${formatMonth(st.month)}`}
                  icon={<EyeIcon />}
                  href={`/admin/budgets/statements/${st.month}`}
                />
                <DownloadButton
                  label={`CSV: ${formatMonth(st.month)}`}
                  path={`/api/staff/spend/statements/${st.month}?format=csv`}
                  fallbackName={`statement-${st.month}.csv`}
                  what="CSV"
                />
              </RowActions>
            ),
          };
        })}
        page={{ page: 1, limit: 200, count: statements.length, total: statements.length }}
        empty={{
          icon: <FileSpreadsheetIcon className="size-5" aria-hidden="true" />,
          title: s.emptyTitle,
          description: s.empty,
        }}
      />
    </>
  );
}

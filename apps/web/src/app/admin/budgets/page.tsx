import type { Metadata } from "next";
import * as React from "react";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { BudgetsPanel } from "@/components/admin/providers/BudgetsPanel";
import { SpendPanel } from "@/components/admin/SpendPanel";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { enumFilter, isFiltered } from "@/lib/admin/toolbar";
import { LISTS } from "@/lib/api/lists";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.budgets.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BudgetsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  const lp = listParams(await searchParams, LISTS.budgets);
  const { page, limit } = lp;
  const api = await staffServer();
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [budgetsR, spendR] = await Promise.allSettled([
    api.budgets.list(lp.query),
    api.spend({ from, to: now.toISOString(), groupBy: "purpose" }),
  ]);
  const budgets = settled(budgetsR);
  const spend = settled(spendR);
  return (
    <>
      <PageHeader title={t.admin.budgets.title} subtitle={t.admin.budgets.subtitle} />
      <div className="grid gap-8">
        {budgets.data ? (
          <div>
            <ListToolbar
              searchLabel={t.admin.list.searchBudgets}
              filters={[
                enumFilter(
                  LISTS.budgets,
                  "scope",
                  t.admin.list.fields.scope ?? "Scope",
                  t.admin.list.allScopes,
                  (v) => t.admin.list.scopes[v] ?? v,
                ),
                enumFilter(
                  LISTS.budgets,
                  "period",
                  t.admin.list.fields.period ?? "Period",
                  t.admin.list.allPeriods,
                  (v) => t.admin.budgets.periods[v as "month" | "total"] ?? v,
                ),
              ]}
              sort={{ list: LISTS.budgets, labels: t.admin.list.fields }}
            />
            {budgets.data.items.length === 0 && isFiltered(lp.q, lp.filters) ? (
              <p className="text-muted-foreground py-6 text-sm">{t.admin.list.noMatches}</p>
            ) : null}
            <BudgetsPanel budgets={budgets.data.items} companyId={me?.user.companyId ?? null} />
            <Pagination
              page={page}
              limit={limit}
              count={budgets.data.items.length}
              total={budgets.data.total}
            />
          </div>
        ) : (
          <LoadError error={budgets.error} />
        )}
        {spend.data ? (
          <SpendPanel spend={spend.data} title={t.admin.dashboard.spendTitle} />
        ) : (
          <LoadError error={spend.error} />
        )}
      </div>
    </>
  );
}

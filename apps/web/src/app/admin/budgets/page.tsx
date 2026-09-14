import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { BudgetsPanel } from "@/components/admin/providers/BudgetsPanel";
import { SpendPanel } from "@/components/admin/SpendPanel";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { pageParams } from "@/lib/admin/pagination";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.budgets.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function BudgetsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  const me = await requireMe();
  const { page, limit, offset } = pageParams(await searchParams);
  const api = await staffServer();
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [budgetsR, spendR] = await Promise.allSettled([
    api.budgets.list({ limit, offset }),
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

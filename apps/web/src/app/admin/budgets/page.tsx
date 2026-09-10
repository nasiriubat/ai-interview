import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { BudgetsPanel } from "@/components/admin/providers/BudgetsPanel";
import { SpendPanel } from "@/components/admin/SpendPanel";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.budgets.title };
}

export default async function BudgetsPage(): Promise<React.JSX.Element> {
  const me = await requireMe();
  const api = await staffServer();
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [budgetsR, spendR] = await Promise.allSettled([
    api.budgets.list(),
    api.spend({ from, to: now.toISOString(), groupBy: "campaign" }),
  ]);
  const budgets = settled(budgetsR);
  const spend = settled(spendR);
  return (
    <>
      <PageHeader title={t.admin.budgets.title} subtitle={t.admin.budgets.subtitle} />
      <div className="grid gap-8">
        {budgets.data ? (
          <BudgetsPanel budgets={budgets.data} companyId={me?.user.companyId ?? null} />
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

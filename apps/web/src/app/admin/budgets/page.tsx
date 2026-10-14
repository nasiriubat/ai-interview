import { FileSpreadsheetIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { BudgetsPanel } from "@/components/admin/providers/BudgetsPanel";
import { SpendPanel } from "@/components/admin/SpendPanel";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { hasRole, requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { enumFilterDef } from "@/lib/admin/table-filters";
import { errorMessage } from "@/lib/api/errors";
import { LISTS, sortOf } from "@/lib/api/lists";
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
  const api = await staffServer();
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [budgetsR, spendR, campaignsR] = await Promise.allSettled([
    api.budgets.list(lp.query),
    api.spend({ from, to: now.toISOString(), groupBy: "purpose" }),
    api.settings.scopes("campaign"),
  ]);
  const budgets = settled(budgetsR);
  const spend = settled(spendR);
  const campaigns = settled(campaignsR);
  const names = Object.fromEntries((campaigns.data ?? []).map((c) => [c.id, c.name]));
  return (
    <>
      <PageHeader
        title={t.admin.budgets.title}
        subtitle={t.admin.budgets.subtitle}
        secondaryActions={
          hasRole(me, ["admin", "platform_operator"]) ? (
            <Button asChild variant="outline">
              <Link href="/admin/budgets/statements">
                <FileSpreadsheetIcon /> {t.ws.statements.title}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        {spend.data ? (
          <SpendPanel spend={spend.data} title={t.admin.dashboard.spendTitle} />
        ) : (
          <LoadError error={spend.error} />
        )}
        <BudgetsPanel
          budgets={budgets.data?.items ?? []}
          companyId={me?.user.companyId ?? null}
          page={{
            page: lp.page,
            limit: lp.limit,
            count: budgets.data?.items.length ?? 0,
            total: budgets.data?.total ?? null,
          }}
          filters={[
            enumFilterDef(
              LISTS.budgets,
              "scope",
              t.admin.list.fields.scope ?? "Scope",
              (v) => t.admin.list.scopes[v] ?? v,
            ),
            enumFilterDef(
              LISTS.budgets,
              "period",
              t.admin.list.fields.period ?? "Period",
              (v) => t.admin.budgets.periods[v as "month" | "total"] ?? v,
            ),
          ]}
          sort={sortOf(LISTS.budgets)}
          error={budgets.error ? errorMessage(budgets.error, t.app.unknownError) : undefined}
          campaignNames={names}
        />
      </div>
    </>
  );
}

import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { SpendPanel } from "@/components/admin/SpendPanel";
import { StatsGroups } from "@/components/admin/StatsGroups";
import { t } from "@/i18n";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export const metadata: Metadata = { title: t.admin.dashboard.title };

function monthRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  return { from, to: now.toISOString() };
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  await requireMe();
  const api = await staffServer();
  const [statsR, spendR] = await Promise.allSettled([
    api.stats(),
    api.spend({ ...monthRange(), groupBy: "purpose" }),
  ]);
  const stats = settled(statsR);
  const spend = settled(spendR);
  return (
    <>
      <PageHeader title={t.admin.dashboard.title} subtitle={t.admin.dashboard.subtitle} />
      <div className="grid gap-8">
        {spend.data ? (
          <SpendPanel spend={spend.data} title={t.admin.dashboard.spendTitle} />
        ) : (
          <LoadError error={spend.error} />
        )}
        {stats.data ? (
          <StatsGroups stats={stats.data} />
        ) : (
          <LoadError error={stats.error} title={t.admin.dashboard.statsUnavailable} />
        )}
      </div>
    </>
  );
}

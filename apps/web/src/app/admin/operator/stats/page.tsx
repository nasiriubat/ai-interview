import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatsGroups } from "@/components/admin/StatsGroups";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.operator.statsTitle };
}

export default async function PlatformStatsPage(): Promise<React.JSX.Element> {
  await requireMe();
  const api = await staffServer();
  const [statsR] = await Promise.allSettled([api.operator.stats()]);
  const stats = settled(statsR);
  return (
    <>
      <PageHeader title={t.admin.operator.statsTitle} />
      {stats.data ? <StatsGroups stats={stats.data} /> : <LoadError error={stats.error} />}
    </>
  );
}

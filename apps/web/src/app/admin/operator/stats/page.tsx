import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatsGroups } from "@/components/admin/StatsGroups";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.operator.statsTitle };
}

export default async function PlatformStatsPage(): Promise<React.JSX.Element> {
  const api = await staffServer();
  const stats = await api.operator.stats();
  return (
    <>
      <PageHeader title={t.admin.operator.statsTitle} />
      <StatsGroups stats={stats} />
    </>
  );
}

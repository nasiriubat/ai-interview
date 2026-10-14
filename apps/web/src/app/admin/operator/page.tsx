import type { Metadata } from "next";
import * as React from "react";
import { settled } from "@/components/admin/LoadError";
import { TenantsPanel } from "@/components/admin/operator/TenantsPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { statusFilterDef } from "@/lib/admin/table-filters";
import { errorMessage } from "@/lib/api/errors";
import { LISTS, sortOf } from "@/lib/api/lists";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.operator.tenantsTitle };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TenantsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const lp = listParams(await searchParams, LISTS.tenants);
  const api = await staffServer();
  const [tenantsR] = await Promise.allSettled([api.operator.tenants.list(lp.query)]);
  const tenants = settled(tenantsR);
  return (
    <>
      <PageHeader title={t.admin.operator.tenantsTitle} subtitle={t.admin.operator.tenantsSubtitle} />
      <TenantsPanel
        tenants={tenants.data?.items ?? []}
        page={{
          page: lp.page,
          limit: lp.limit,
          count: tenants.data?.items.length ?? 0,
          total: tenants.data?.total ?? null,
        }}
        filters={[statusFilterDef(LISTS.tenants)]}
        sort={sortOf(LISTS.tenants)}
        error={tenants.error ? errorMessage(tenants.error, t.app.unknownError) : undefined}
      />
    </>
  );
}

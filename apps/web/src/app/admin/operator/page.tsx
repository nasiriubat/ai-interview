import type { Metadata } from "next";
import * as React from "react";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { LoadError, settled } from "@/components/admin/LoadError";
import { TenantsPanel } from "@/components/admin/operator/TenantsPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { statusFilter } from "@/lib/admin/toolbar";
import { LISTS } from "@/lib/api/lists";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.operator.tenantsTitle };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TenantsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const lp = listParams(await searchParams, LISTS.tenants);
  const { page, limit } = lp;
  const api = await staffServer();
  const [tenantsR] = await Promise.allSettled([api.operator.tenants.list(lp.query)]);
  const tenants = settled(tenantsR);
  return (
    <>
      <PageHeader title={t.admin.operator.tenantsTitle} subtitle={t.admin.operator.tenantsSubtitle} />
      <ListToolbar
        searchLabel={t.admin.list.searchTenants}
        filters={[statusFilter(LISTS.tenants)]}
        sort={{ list: LISTS.tenants, labels: t.admin.list.fields }}
      />
      {tenants.data ? (
        <>
          <TenantsPanel tenants={tenants.data.items} />
          <Pagination
            page={page}
            limit={limit}
            count={tenants.data.items.length}
            total={tenants.data.total}
          />
        </>
      ) : (
        <LoadError error={tenants.error} />
      )}
    </>
  );
}

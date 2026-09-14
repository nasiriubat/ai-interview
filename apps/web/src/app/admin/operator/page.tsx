import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { TenantsPanel } from "@/components/admin/operator/TenantsPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { pageParams } from "@/lib/admin/pagination";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.operator.tenantsTitle };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TenantsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const { page, limit, offset } = pageParams(await searchParams);
  const api = await staffServer();
  const [tenantsR] = await Promise.allSettled([api.operator.tenants.list({ limit, offset })]);
  const tenants = settled(tenantsR);
  return (
    <>
      <PageHeader title={t.admin.operator.tenantsTitle} subtitle={t.admin.operator.tenantsSubtitle} />
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

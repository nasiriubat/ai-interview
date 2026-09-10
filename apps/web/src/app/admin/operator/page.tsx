import type { Metadata } from "next";
import * as React from "react";
import { TenantsPanel } from "@/components/admin/operator/TenantsPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { t } from "@/i18n";
import { staffServer } from "@/lib/api/server";

export const metadata: Metadata = { title: t.admin.operator.tenantsTitle };

export default async function TenantsPage(): Promise<React.JSX.Element> {
  const api = await staffServer();
  const tenants = await api.operator.tenants.list();
  return (
    <>
      <PageHeader title={t.admin.operator.tenantsTitle} subtitle={t.admin.operator.tenantsSubtitle} />
      <TenantsPanel tenants={tenants} />
    </>
  );
}

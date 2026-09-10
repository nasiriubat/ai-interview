import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { ProvidersPanel } from "@/components/admin/providers/ProvidersPanel";
import { t } from "@/i18n";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export const metadata: Metadata = { title: t.admin.providers.title };

export default async function ProvidersPage(): Promise<React.JSX.Element> {
  await requireMe();
  const api = await staffServer();
  const providers = await api.providers.list();
  return (
    <>
      <PageHeader title={t.admin.providers.title} subtitle={t.admin.providers.subtitle} />
      <ProvidersPanel providers={providers} scope="tenant" />
    </>
  );
}

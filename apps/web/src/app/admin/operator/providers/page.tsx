import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { ProvidersPanel } from "@/components/admin/providers/ProvidersPanel";
import { t } from "@/i18n";
import { staffServer } from "@/lib/api/server";

export const metadata: Metadata = { title: t.admin.nav.platformProviders };

export default async function PlatformProvidersPage(): Promise<React.JSX.Element> {
  const api = await staffServer();
  const providers = await api.operator.providers.list();
  return (
    <>
      <PageHeader title={t.admin.nav.platformProviders} subtitle={t.admin.providers.subtitle} />
      <ProvidersPanel providers={providers} scope="platform" />
    </>
  );
}

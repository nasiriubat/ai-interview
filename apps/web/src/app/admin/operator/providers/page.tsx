import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { ProvidersPanel } from "@/components/admin/providers/ProvidersPanel";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.nav.platformProviders };
}

export default async function PlatformProvidersPage(): Promise<React.JSX.Element> {
  await requireMe();
  const api = await staffServer();
  const [providersR] = await Promise.allSettled([api.operator.providers.list()]);
  const providers = settled(providersR);
  return (
    <>
      <PageHeader title={t.admin.nav.platformProviders} subtitle={t.admin.providers.subtitle} />
      {providers.data ? (
        <ProvidersPanel providers={providers.data} scope="platform" />
      ) : (
        <LoadError error={providers.error} />
      )}
    </>
  );
}

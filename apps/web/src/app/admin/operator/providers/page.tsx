import type { Metadata } from "next";
import * as React from "react";
import { settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { AddProviderDialog, ProvidersPanel } from "@/components/admin/providers/ProvidersPanel";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { errorMessage } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.nav.platformProviders };
}

export default async function PlatformProvidersPage(): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const api = await staffServer();
  const [providersR] = await Promise.allSettled([api.operator.providers.list()]);
  const providers = settled(providersR);
  return (
    <>
      <PageHeader
        title={t.admin.nav.platformProviders}
        subtitle={t.admin.providers.subtitle}
        actions={<AddProviderDialog scope="platform" />}
      />
      <ProvidersPanel
        providers={providers.data ?? []}
        scope="platform"
        error={providers.error ? errorMessage(providers.error, t.app.unknownError) : undefined}
      />
    </>
  );
}

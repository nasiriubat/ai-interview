import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { AddProviderDialog, ProvidersPanel } from "@/components/admin/providers/ProvidersPanel";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { errorMessage } from "@/lib/api/errors";
import type { Provider } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.providers.title };
}

export default async function ProvidersPage(): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const api = await staffServer();
  let providers: Provider[] = [];
  let error: string | undefined;
  try {
    providers = await api.providers.list();
  } catch (e) {
    error = errorMessage(e, t.app.unknownError);
  }
  return (
    <>
      <PageHeader
        title={t.admin.providers.title}
        subtitle={t.admin.providers.subtitle}
        actions={<AddProviderDialog scope="tenant" />}
      />
      <ProvidersPanel providers={providers} scope="tenant" error={error} />
    </>
  );
}

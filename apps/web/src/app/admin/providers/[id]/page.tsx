import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { ModelsPanel } from "@/components/admin/providers/ModelsPanel";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";
import { label } from "@/lib/i18n/enums";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.providers.models };
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ProviderModelsPage({ params }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const { id } = await params;
  const api = await staffServer();
  const [providersR, pricesR, catalogueR] = await Promise.allSettled([
    api.providers.list(),
    api.providers.prices(id, { limit: 200 }),
    api.providers.models(id),
  ]);
  const providers = settled(providersR);
  if (!providers.data) return <LoadError error={providers.error} />;
  const provider = providers.data.find((p) => p.id === id);
  if (!provider) notFound();
  const prices = settled(pricesR);
  const catalogue = settled(catalogueR);
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: provider.name }}
        title={provider.name}
        subtitle={`${label("providerKind", provider.kind)} · ${t.admin.providers.models}`}
      />
      <ModelsPanel
        providerId={id}
        prices={prices.data?.items ?? []}
        catalogue={catalogue.data}
        catalogueError={catalogue.error}
        scope="tenant"
      />
    </>
  );
}

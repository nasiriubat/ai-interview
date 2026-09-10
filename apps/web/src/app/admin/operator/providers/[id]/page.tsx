import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { ModelsPanel } from "@/components/admin/providers/ModelsPanel";
import { t } from "@/i18n";
import { staffServer } from "@/lib/api/server";

export const metadata: Metadata = { title: t.admin.providers.models };

interface Props {
  params: Promise<{ id: string }>;
}

export default async function PlatformProviderModelsPage({ params }: Props): Promise<React.JSX.Element> {
  const { id } = await params;
  const api = await staffServer();
  const [providers, prices] = await Promise.all([
    api.operator.providers.list(),
    api.operator.providers.prices(id).catch(() => []),
  ]);
  const provider = providers.find((p) => p.id === id);
  if (!provider) notFound();
  return (
    <>
      <PageHeader title={provider.name} subtitle={`${provider.kind} · ${t.admin.providers.models}`} />
      <ModelsPanel providerId={id} prices={prices} scope="platform" />
    </>
  );
}

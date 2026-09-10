import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { RoutesForm } from "@/components/admin/providers/RoutesForm";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.nav.platformRoutes };
}

export default async function PlatformRoutesPage(): Promise<React.JSX.Element> {
  const api = await staffServer();
  const [routes, providers] = await Promise.all([api.operator.routes.get(), api.operator.providers.list()]);
  return (
    <>
      <PageHeader title={t.admin.nav.platformRoutes} subtitle={t.admin.routes.subtitle} />
      <RoutesForm
        routes={routes}
        providers={providers.filter((p) => p.enabled)}
        scope="platform"
        companyId={null}
      />
    </>
  );
}

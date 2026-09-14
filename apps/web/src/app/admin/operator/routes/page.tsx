import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { RoutesForm } from "@/components/admin/providers/RoutesForm";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.nav.platformRoutes };
}

export default async function PlatformRoutesPage(): Promise<React.JSX.Element> {
  await requireMe();
  const api = await staffServer();
  const [routesR, providersR] = await Promise.allSettled([
    api.operator.routes.get(),
    api.operator.providers.list(),
  ]);
  const routes = settled(routesR);
  const providers = settled(providersR);
  return (
    <>
      <PageHeader title={t.admin.nav.platformRoutes} subtitle={t.admin.routes.subtitle} />
      {routes.data && providers.data ? (
        <RoutesForm
          routes={routes.data}
          providers={providers.data.filter((p) => p.enabled)}
          scope="platform"
          companyId={null}
        />
      ) : (
        <LoadError error={routes.error ?? providers.error} />
      )}
    </>
  );
}

import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { RoutesForm } from "@/components/admin/providers/RoutesForm";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.routes.title };
}

export default async function RoutesPage(): Promise<React.JSX.Element> {
  const me = await requireMe();
  const api = await staffServer();
  const [routes, providers] = await Promise.all([api.routes.get(), api.providers.list()]);
  return (
    <>
      <PageHeader title={t.admin.routes.title} subtitle={t.admin.routes.subtitle} />
      <RoutesForm
        routes={routes}
        providers={providers.filter((p) => p.enabled)}
        scope="tenant"
        companyId={me?.user.companyId ?? null}
      />
    </>
  );
}

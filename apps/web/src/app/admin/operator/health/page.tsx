import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { HealthPanel } from "@/components/admin/operator/HealthPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { RefreshButton } from "@/components/admin/RefreshButton";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.operator.health.title };
}

/**
 * Every platform signal and each tenant's use of its limits on one page (D-222). The operator
 * opens it first thing: a row that is not green is the thing to look at, and each signal's key is
 * the anchor of its section in docs/OPERATIONS.md. The error log's numbers sit with them (D-477).
 */
export default async function PlatformHealthPage(): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const api = await staffServer();
  const [healthR, errorsR] = await Promise.allSettled([api.operator.health(), api.operator.errors.summary()]);
  const health = settled(healthR);
  const errors = settled(errorsR);
  return (
    <>
      <PageHeader
        title={t.admin.operator.health.title}
        subtitle={t.admin.operator.health.subtitle}
        actions={<RefreshButton />}
      />
      {health.data ? (
        <HealthPanel health={health.data} errors={errors.data ?? undefined} />
      ) : (
        <LoadError error={health.error} />
      )}
    </>
  );
}

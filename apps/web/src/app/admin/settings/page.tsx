import { CURRENT_RELEASE } from "@aidp/shared";
import type { Metadata } from "next";
import * as React from "react";
import { LoadError } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { HistoryPanel } from "@/components/admin/settings/HistoryPanel";
import { ScopePicker } from "@/components/admin/settings/ScopePicker";
import { SettingsCategories } from "@/components/admin/settings/SettingsCategories";
import { SettingsSearch } from "@/components/admin/settings/SettingsSearch";
import { WhatChangedPanel } from "@/components/admin/settings/WhatChangedPanel";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import type { SettingsHistory, SettingsResponse } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.settings.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SettingsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  const sp = await searchParams;
  const scope = typeof sp.scope === "string" ? sp.scope : "tenant";
  const scopeId = typeof sp.scopeId === "string" ? sp.scopeId : "";
  const category = typeof sp.category === "string" ? sp.category : undefined;
  // Template and campaign settings belong to one template or campaign. Without a target there is
  // nothing to show, and showing the tenant's values under that scope's name would be a lie.
  const awaitingTarget = (scope === "template" || scope === "campaign") && !scopeId;
  const api = await staffServer();
  let data: SettingsResponse | null = null;
  let error: unknown = null;
  let history: SettingsHistory | null = null;
  if (!awaitingTarget) {
    // The history is a convenience beside the form: it failing must not take the settings down.
    const [dataR, historyR] = await Promise.allSettled([
      api.settings.get({ scope, ...(scopeId ? { scopeId } : {}) }),
      api.settings.history({ limit: 30 }),
    ]);
    if (dataR.status === "fulfilled") data = dataR.value;
    else error = dataR.reason;
    if (historyR.status === "fulfilled") history = historyR.value;
  }
  const searchable = data?.catalog.filter((c) => c.category !== "ui" && c.scopes.includes(scope)) ?? [];
  return (
    <>
      <PageHeader title={t.admin.settings.title} subtitle={t.admin.settings.subtitle} />
      <ScopePicker
        scope={scope}
        scopeId={scopeId}
        allowPlatform={me?.user.role === "platform_operator"}
        {...(category ? { extraParams: { category } } : {})}
      />
      {awaitingTarget ? (
        <p className="text-muted-foreground bg-card shadow-card rounded-lg p-5 text-sm">
          {t.admin.form.scopeInstruction(
            t.admin.settings.scopes[scope === "template" ? "template" : "campaign"].toLowerCase(),
          )}
        </p>
      ) : data ? (
        <div className="grid gap-6">
          <WhatChangedPanel
            catalog={data.catalog}
            history={history?.items ?? []}
            release={CURRENT_RELEASE}
            myEmail={me?.user.email}
            scope={scope}
            scopeId={scopeId || undefined}
          />
          <SettingsSearch entries={searchable} scope={scope} scopeId={scopeId || undefined} />
          <SettingsCategories
            data={data}
            scope={scope}
            scopeId={scopeId || undefined}
            category={category}
            operator={me?.user.role === "platform_operator"}
          />
          {history ? <HistoryPanel items={history.items} /> : null}
        </div>
      ) : (
        <LoadError error={error} />
      )}
    </>
  );
}

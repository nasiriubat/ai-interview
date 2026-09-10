import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { ScopePicker } from "@/components/admin/settings/ScopePicker";
import { SettingsForm } from "@/components/admin/settings/SettingsForm";
import { t } from "@/i18n";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export const metadata: Metadata = { title: t.admin.settings.title };

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SettingsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  const me = await requireMe();
  const sp = await searchParams;
  const scope = typeof sp.scope === "string" ? sp.scope : "tenant";
  const scopeId = typeof sp.scopeId === "string" ? sp.scopeId : "";
  const api = await staffServer();
  const data = await api.settings.get({ scope, ...(scopeId ? { scopeId } : {}) });
  return (
    <>
      <PageHeader title={t.admin.settings.title} subtitle={t.admin.settings.subtitle} />
      <ScopePicker scope={scope} scopeId={scopeId} allowPlatform={me?.user.role === "platform_operator"} />
      <SettingsForm key={`${scope}:${scopeId}`} data={data} scope={scope} scopeId={scopeId || undefined} />
    </>
  );
}

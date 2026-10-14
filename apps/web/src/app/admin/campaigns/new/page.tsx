import type { Metadata } from "next";
import * as React from "react";
import { CampaignForm } from "@/components/admin/campaigns/CampaignForm";
import { PageHeader } from "@/components/admin/PageHeader";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.campaigns.createTitle };
}

export default async function NewCampaignPage(): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const api = await staffServer();
  const [list, tenant] = await Promise.all([
    api.templates.list(),
    api.settings.get({ scope: "tenant" }).catch(() => undefined),
  ]);
  const templates = list.filter((tpl) => tpl.status !== "archived");
  const verification = (tenant?.effective ?? tenant?.values)?.["campaign.verification"];
  return (
    <>
      <PageHeader title={t.admin.campaigns.createTitle} subtitle={t.admin.campaigns.createBody} />
      <CampaignForm
        templates={templates}
        defaultVerification={typeof verification === "string" ? verification : undefined}
      />
    </>
  );
}

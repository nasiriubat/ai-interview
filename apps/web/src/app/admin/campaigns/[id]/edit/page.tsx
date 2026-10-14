import { defaultConsentText } from "@aidp/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { CampaignEditForm, type ConsentView } from "@/components/admin/campaigns/CampaignEditForm";
import { PageHeader } from "@/components/admin/PageHeader";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";
import { label } from "@/lib/i18n/enums";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.campaigns.editTitle };
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditCampaignPage({ params }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const { id } = await params;
  const api = await staffServer();
  let campaign;
  try {
    campaign = await api.campaigns.get(id);
  } catch (e) {
    if (isApiError(e) && e.isNotFound) notFound();
    throw e;
  }
  const [templateR, ownR, tenantR] = await Promise.allSettled([
    campaign.templateId ? api.templates.get(campaign.templateId) : Promise.resolve(undefined),
    api.settings.get({ scope: "campaign", scopeId: id }),
    api.settings.get({ scope: "tenant" }),
  ]);
  const language = templateR.status === "fulfilled" ? (templateR.value?.language ?? "en") : "en";
  const own = ownR.status === "fulfilled" ? ownR.value.values["campaign.consentText"] : undefined;
  const tenantText =
    tenantR.status === "fulfilled" ? tenantR.value.values["campaign.consentText"] : undefined;
  const consent: ConsentView = {
    own: typeof own === "string" && own !== "" ? own : null,
    defaultText: defaultConsentText(language),
    language: label("language", language),
    organizationText: typeof tenantText === "string" && tenantText !== "" ? tenantText : null,
  };
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: campaign.name }}
        title={t.admin.campaigns.editTitle}
        subtitle={campaign.name}
      />
      <CampaignEditForm campaign={campaign} consent={consent} />
    </>
  );
}

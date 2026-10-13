import { ArrowLeftIcon, FileTextIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { ResultsView } from "@/components/admin/results/ResultsView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isWeightsPreset, parseWeights } from "@/lib/analysis/rank";
import { isApiError } from "@/lib/api/errors";
import type { AnalysisDetail } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.results.title };
}

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ResultsPage({ params, searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const { id } = await params;
  const sp = await searchParams;
  const requested = typeof sp.version === "string" ? sp.version : undefined;
  const api = await staffServer();
  const [campaignR, analysesR, settingsR] = await Promise.allSettled([
    api.campaigns.get(id),
    api.analyses.list(id),
    api.settings.get({ scope: "campaign", scopeId: id }),
  ]);
  if (campaignR.status === "rejected") {
    if (isApiError(campaignR.reason) && campaignR.reason.isNotFound) notFound();
    throw campaignR.reason;
  }
  const campaign = campaignR.value;
  const analyses = settled(analysesR);
  const list = analyses.data?.items ?? [];
  // Default to the newest finished run so a freshly queued analysis does not blank the page.
  const selected = list.find((a) => a.id === requested) ?? list.find((a) => a.status === "done") ?? list[0];

  let detail: AnalysisDetail | null = null;
  let detailError: unknown = null;
  if (selected && selected.status !== "queued") {
    try {
      detail = await api.analyses.get(selected.id);
    } catch (e) {
      detailError = e;
    }
  }

  const values = settled(settingsR).data?.values ?? {};
  const rawPreset = values["analysis.weightsPreset"];
  const s = t.admin.results;
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: campaign.name }}
        title={`${campaign.name} · ${s.title}`}
        subtitle={s.subtitle}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={`/admin/campaigns/${campaign.id}`}>
                <ArrowLeftIcon /> {s.backToCampaign}
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/admin/campaigns/${campaign.id}/report`}>
                <FileTextIcon /> {s.openReport}
              </Link>
            </Button>
          </>
        }
      />
      {analyses.error ? <LoadError error={analyses.error} /> : null}
      {detailError ? <LoadError error={detailError} /> : null}
      <ResultsView
        key={selected?.id ?? "none"}
        campaignId={campaign.id}
        analyses={list}
        selectedId={selected?.id}
        detail={detail}
        initialPreset={isWeightsPreset(rawPreset) ? rawPreset : "balanced"}
        initialWeights={parseWeights(values["analysis.weights"])}
      />
    </>
  );
}

import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as React from "react";
import { ExportsPanel } from "@/components/admin/ExportsPanel";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { ReportView } from "@/components/report/ReportView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import type { Report } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";
import { analysisReportPdfUrl } from "@/lib/api/staff";
import { parseReportSections } from "@/lib/report/sections";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.report.title };
}

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReportPage({ params, searchParams }: Props): Promise<React.JSX.Element> {
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
  const selected = list.find((a) => a.id === requested) ?? list.find((a) => a.status === "done");

  let report: Report | null = null;
  let reportError: unknown = null;
  if (selected) {
    try {
      report = (await api.analyses.get(selected.id)).report;
    } catch (e) {
      reportError = e;
    }
  }
  const values = settled(settingsR).data?.values ?? {};
  const s = t.admin.report;
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: campaign.name }}
        title={`${campaign.name} · ${s.title}`}
        subtitle={s.subtitle}
        actions={
          <Button asChild variant="outline" className="print:hidden">
            <Link href={`/admin/campaigns/${campaign.id}/results`}>
              <ArrowLeftIcon /> {s.backToResults}
            </Link>
          </Button>
        }
      />
      {analyses.error ? <LoadError error={analyses.error} /> : null}
      {reportError ? <LoadError error={reportError} /> : null}
      {selected && report ? (
        <ExportsPanel
          items={[
            {
              id: "pdf",
              label: t.admin.exportsPanel.pdf,
              what: "PDF",
              url: analysisReportPdfUrl(selected.id),
              fallbackName: `report-v${report.version}.pdf`,
            },
            {
              id: "md",
              label: t.admin.exportsPanel.markdown,
              what: "Markdown",
              fallbackName: `report-v${report.version}.md`,
              text: {
                content: report.markdown,
                filename: `${slugOf(campaign.name)}-report-v${report.version}.md`,
                mime: "text/markdown",
              },
            },
          ]}
        />
      ) : null}
      <ReportView
        key={selected?.id ?? "none"}
        campaignId={campaign.id}
        campaignName={campaign.name}
        analyses={list}
        selected={selected}
        report={report}
        initialSections={parseReportSections(values["analysis.reportSections"])}
      />
    </>
  );
}

/** A file-name stem from a campaign name; the same rule the report view uses for its own download. */
function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "report"
  );
}

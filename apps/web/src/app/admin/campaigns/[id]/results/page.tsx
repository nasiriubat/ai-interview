import { EyeIcon, FileTextIcon, MegaphoneIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as React from "react";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { RefreshButton } from "@/components/admin/RefreshButton";
import { AnalysisStatusBadge } from "@/components/admin/results/AnalysisHeader";
import { ResultsView } from "@/components/admin/results/ResultsView";
import { DataTable } from "@/components/data/DataTable";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isWeightsPreset, parseWeights } from "@/lib/analysis/rank";
import { RESULTS_TABS } from "@/lib/analysis/tabs";
import { isApiError } from "@/lib/api/errors";
import type { AnalysisDetail } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";
import { formatDate } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.results.title };
}

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ResultsPage({ params, searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  const { id } = await params;
  const sp = await searchParams;
  const requested = typeof sp.version === "string" ? sp.version : undefined;
  const tab = RESULTS_TABS.find((x) => x === sp.tab) ?? "overview";
  const api = await staffServer();
  const [campaignR, analysesR, settingsR, tenantR] = await Promise.allSettled([
    api.campaigns.get(id),
    api.analyses.list(id),
    api.settings.get({ scope: "campaign", scopeId: id }),
    // `features.chaining` lives at the organization level; a member who cannot read settings
    // sees the action, and the API's refusal explains it.
    api.settings.get({ scope: "tenant" }),
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

  // Merging, splitting and the comparison by department are for the people who may change results;
  // the comparison is read-only and shown to members as the API allows.
  const canEdit = me?.user.role === "admin" || me?.user.role === "platform_operator";
  const wantsExtras = detail !== null && selected?.status === "done";
  const [departmentsR, editsR] = await Promise.allSettled([
    wantsExtras ? api.analyses.departments(selected.id) : Promise.reject(new Error("none")),
    wantsExtras && canEdit ? api.analyses.clusterEdits(id) : Promise.resolve([]),
  ]);
  const values = settled(settingsR).data?.values ?? {};
  const k = settled(tenantR).data?.effective?.["privacy.kAnonymity"];
  const rawPreset = values["analysis.weightsPreset"];
  const s = t.admin.results;
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: campaign.name }}
        title={`${campaign.name} · ${s.title}`}
        subtitle={s.subtitle}
        secondaryActions={
          <Button asChild variant="outline">
            <Link href={`/admin/campaigns/${campaign.id}`}>
              <MegaphoneIcon /> {s.backToCampaign}
            </Link>
          </Button>
        }
        actions={
          <Button asChild>
            <Link href={`/admin/campaigns/${campaign.id}/report${selected ? `?version=${selected.id}` : ""}`}>
              <FileTextIcon /> {s.openReport}
            </Link>
          </Button>
        }
      />
      {analyses.error ? (
        <div className="grid justify-items-start gap-3">
          <LoadError error={analyses.error} />
          <RefreshButton />
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
          {detailError ? <LoadError error={detailError} /> : null}
          <ResultsView
            key={selected?.id ?? "none"}
            campaignId={campaign.id}
            analyses={list}
            selectedId={selected?.id}
            detail={detail}
            initialPreset={isWeightsPreset(rawPreset) ? rawPreset : "balanced"}
            initialWeights={parseWeights(values["analysis.weights"])}
            canPromote={settled(tenantR).data?.effective?.["features.chaining"] !== false}
            canEdit={canEdit}
            k={typeof k === "number" ? k : 3}
            departments={departmentsR.status === "fulfilled" ? departmentsR.value : null}
            departmentsFailed={wantsExtras && departmentsR.status === "rejected"}
            edits={editsR.status === "fulfilled" ? editsR.value : []}
            initialTab={tab}
            versions={
              <DataTable
                id="analysis-versions"
                label={t.ws.history.title}
                columns={[
                  { id: "version", header: t.ws.history.version, primary: true, locked: true },
                  { id: "status", header: s.statusLabel },
                  { id: "trigger", header: t.ws.history.trigger },
                  { id: "sessions", header: s.stats.sessions, align: "end" },
                  { id: "clusters", header: s.stats.clusters, align: "end" },
                  { id: "finished", header: t.ws.history.finished },
                ]}
                rows={list.map((a, i) => ({
                  id: a.id,
                  label: s.versionOption(a.version, s.status[a.status]),
                  cells: {
                    version: (
                      <span className="font-medium">
                        {`v${String(a.version)}`}
                        {i === 0 ? (
                          <span className="text-muted-foreground font-normal">{` · ${s.latest}`}</span>
                        ) : null}
                        {a.id === selected?.id ? (
                          <span className="text-primary font-normal">{` · ${t.ws.history.shown}`}</span>
                        ) : null}
                      </span>
                    ),
                    status: <AnalysisStatusBadge status={a.status} />,
                    trigger: (
                      <span className="text-muted-foreground">
                        {a.stats.trigger ? s.trigger[a.stats.trigger] : t.admin.common.dash}
                      </span>
                    ),
                    sessions: a.stats.sessions,
                    clusters: a.stats.clusters,
                    finished: (
                      <span className="text-muted-foreground">{formatDate(a.finishedAt ?? a.createdAt)}</span>
                    ),
                  },
                  actions: (
                    <RowActions>
                      {a.status === "done" ? (
                        <>
                          <IconButton
                            label={`${t.ws.history.showResults}: v${String(a.version)}`}
                            icon={<EyeIcon />}
                            href={`/admin/campaigns/${campaign.id}/results?version=${a.id}&tab=overview`}
                          />
                          <IconButton
                            label={`${t.ws.history.showReport}: v${String(a.version)}`}
                            icon={<FileTextIcon />}
                            href={`/admin/campaigns/${campaign.id}/report?version=${a.id}`}
                          />
                        </>
                      ) : null}
                    </RowActions>
                  ),
                }))}
                page={{ page: 1, limit: 200, count: list.length, total: analyses.data?.total ?? list.length }}
                error={analyses.error ? t.app.unknownError : undefined}
                empty={{ title: s.noAnalyses }}
              />
            }
          />
        </div>
      )}
    </>
  );
}

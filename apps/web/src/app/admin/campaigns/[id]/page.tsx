import { BarChart3Icon, DownloadIcon, FileTextIcon, PencilIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as React from "react";
import { CampaignActions } from "@/components/admin/campaigns/CampaignActions";
import { CampaignOverview, type OverviewData } from "@/components/admin/campaigns/CampaignOverview";
import { CampaignSettingsTab } from "@/components/admin/campaigns/CampaignSettingsTab";
import { CampaignTabs, tabFrom } from "@/components/admin/campaigns/CampaignTabs";
import { InvitationsPanel } from "@/components/admin/campaigns/InvitationsPanel";
import { SessionsTable } from "@/components/admin/campaigns/SessionsTable";
import { EmptyState } from "@/components/admin/EmptyState";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { Panel } from "@/components/admin/Panel";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DateText } from "@/components/common/DateText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { enumFilter, isFiltered, statusFilter } from "@/lib/admin/toolbar";
import { isApiError } from "@/lib/api/errors";
import { LISTS, sortOf } from "@/lib/api/lists";
import type { Campaign } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.campaigns.title };
}

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Spend is read over this long a window; a campaign is never older than the product. */
const SPEND_WINDOW_MS = 5 * 365 * 86_400_000;

export default async function CampaignPage({ params, searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  const { id } = await params;
  const sp = await searchParams;
  const tab = tabFrom(sp.tab);
  const api = await staffServer();
  const isAdmin = me?.user.role === "admin" || me?.user.role === "platform_operator";

  let campaign;
  try {
    campaign = await api.campaigns.get(id);
  } catch (e) {
    if (isApiError(e) && e.isNotFound) notFound();
    throw e;
  }
  const s = t.admin.campaigns;

  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: campaign.name }}
        title={campaign.name}
        subtitle={[
          campaign.templateKey,
          campaign.verification ? s.verificationOptions[campaign.verification] : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <StatusBadge status={campaign.status} />
            {isAdmin ? (
              <>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/admin/campaigns/${campaign.id}/edit`}>
                    <PencilIcon aria-hidden="true" /> {s.edit}
                  </Link>
                </Button>
                <CampaignActions campaign={campaign} />
              </>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/campaigns/${campaign.id}/results`}>
                <BarChart3Icon aria-hidden="true" /> {s.results}
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/campaigns/${campaign.id}/report`}>
                <FileTextIcon aria-hidden="true" /> {s.report}
              </Link>
            </Button>
          </>
        }
      />
      <div className="grid gap-6">
        <CampaignTabs campaignId={campaign.id} current={tab} />
        {tab === "overview" ? <Overview campaignId={id} campaign={campaign} /> : null}
        {tab === "invitations" ? <Invitations campaignId={id} /> : null}
        {tab === "sessions" ? <Sessions campaignId={id} searchParams={sp} isAdmin={isAdmin} /> : null}
        {tab === "analysis" ? <AnalysisTab campaignId={id} /> : null}
        {tab === "settings" ? <SettingsTab campaignId={id} /> : null}
      </div>
    </>
  );
}

async function Overview({
  campaignId,
  campaign,
}: {
  campaignId: string;
  campaign: Campaign;
}): Promise<React.JSX.Element> {
  const api = await staffServer();
  const [analysesR, budgetsR, spendR, templateR] = await Promise.allSettled([
    api.analyses.list(campaignId, { limit: 1 }),
    api.budgets.list({ scope: "campaign", q: campaignId, limit: 5 }),
    api.spend({ from: new Date(Date.now() - SPEND_WINDOW_MS).toISOString(), groupBy: "campaign" }),
    campaign.templateId ? api.templates.get(campaign.templateId) : Promise.resolve(undefined),
  ]);
  const analyses = settled(analysesR);
  const budgets = settled(budgetsR);
  const spend = settled(spendR);
  const template = templateR.status === "fulfilled" ? templateR.value : undefined;
  // The area keys are template data: the template's own names win, the shipped names are the fallback.
  const areaNames: Record<string, string> = {};
  for (const a of template?.coverageAreas ?? []) areaNames[a.key] = a.name;
  const spent = spend.data?.rows.find((r) => r.key === campaignId)?.costCents ?? 0;
  const limit = budgets.data?.items.find((b) => b.scopeId === campaignId)?.limitCents ?? null;
  const data: OverviewData = {
    latestAnalysis: analyses.data?.items[0],
    analysisError: analyses.error,
    spend: spend.data ? { spentCents: spent, limitCents: limit } : null,
    areaNames,
  };
  return <CampaignOverview campaign={campaign} data={data} />;
}

async function Invitations({ campaignId }: { campaignId: string }): Promise<React.JSX.Element> {
  const api = await staffServer();
  const [invitationsR] = await Promise.allSettled([api.campaigns.invitations(campaignId)]);
  const invitations = settled(invitationsR);
  const s = t.admin.campaigns;
  return (
    <Panel title={s.invitationsTitle}>
      <div className="px-5 py-4">
        {invitations.data ? (
          <InvitationsPanel campaignId={campaignId} invitations={invitations.data} />
        ) : (
          <LoadError error={invitations.error} />
        )}
      </div>
    </Panel>
  );
}

async function Sessions({
  campaignId,
  searchParams,
  isAdmin,
}: {
  campaignId: string;
  searchParams: Record<string, string | string[] | undefined>;
  isAdmin: boolean;
}): Promise<React.JSX.Element> {
  const api = await staffServer();
  const lp = listParams(searchParams, LISTS.campaignSessions);
  const [sessionsR] = await Promise.allSettled([api.campaigns.sessions(campaignId, lp.query)]);
  const sessions = settled(sessionsR);
  const s = t.admin.campaigns;
  return (
    <Panel
      title={s.sessionsTitle}
      actions={
        isAdmin ? (
          <Button asChild variant="outline" size="sm">
            <a href={`/api/staff/campaigns/${encodeURIComponent(campaignId)}/sessions.csv`} download>
              <DownloadIcon aria-hidden="true" /> {s.exportCsv}
            </a>
          </Button>
        ) : null
      }
      description={isAdmin ? s.exportCsvHint : undefined}
    >
      <div className="px-5 py-4">
        {sessions.data ? (
          <>
            <ListToolbar
              searchLabel={t.admin.list.searchSessions}
              filters={[
                statusFilter(LISTS.campaignSessions),
                enumFilter(LISTS.campaignSessions, "flagged", s.flagFilterLabel, s.flagFilterAll, (v) =>
                  v === "true" ? s.flagFilterOn : s.flagFilterOff,
                ),
              ]}
              sort={{ list: sortOf(LISTS.campaignSessions), labels: t.admin.list.fields }}
            />
            {sessions.data.items.length === 0 && isFiltered(lp.q, lp.filters) ? (
              <EmptyState text={t.admin.list.noMatches} />
            ) : (
              <SessionsTable sessions={sessions.data.items} />
            )}
            <Pagination
              page={lp.page}
              limit={lp.limit}
              count={sessions.data.items.length}
              total={sessions.data.total}
            />
          </>
        ) : (
          <LoadError error={sessions.error} />
        )}
      </div>
    </Panel>
  );
}

async function AnalysisTab({ campaignId }: { campaignId: string }): Promise<React.JSX.Element> {
  const api = await staffServer();
  const [analysesR] = await Promise.allSettled([api.analyses.list(campaignId, { limit: 50 })]);
  const analyses = settled(analysesR);
  const s = t.admin.campaigns;
  if (!analyses.data) return <LoadError error={analyses.error} />;
  if (analyses.data.items.length === 0) {
    return (
      <EmptyState text={s.analysisHistoryEmpty}>
        <Button asChild variant="outline" size="sm">
          <Link href={`/admin/campaigns/${campaignId}/results`}>{s.analysisOpenResults}</Link>
        </Button>
      </EmptyState>
    );
  }
  return (
    <Panel
      title={s.analysisList}
      actions={
        <>
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/campaigns/${campaignId}/results`}>
              <BarChart3Icon aria-hidden="true" /> {s.analysisOpenResults}
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/campaigns/${campaignId}/report`}>
              <FileTextIcon aria-hidden="true" /> {s.analysisOpenReport}
            </Link>
          </Button>
        </>
      }
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.analysisVersion}</TableHead>
              <TableHead>{s.status}</TableHead>
              <TableHead>{s.analysisCreated}</TableHead>
              <TableHead className="text-right">{s.analysisInterviews}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {analyses.data.items.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">
                  v{a.version}{" "}
                  {a.preliminary ? <Badge variant="outline">{t.admin.results.preliminary}</Badge> : null}
                </TableCell>
                <TableCell>
                  <StatusBadge status={a.status} />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  <DateText iso={a.createdAt} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{a.stats.sessions}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}

async function SettingsTab({ campaignId }: { campaignId: string }): Promise<React.JSX.Element> {
  const api = await staffServer();
  const [settingsR] = await Promise.allSettled([
    api.settings.get({ scope: "campaign", scopeId: campaignId }),
  ]);
  const settings = settled(settingsR);
  if (!settings.data) return <LoadError error={settings.error} />;
  return <CampaignSettingsTab campaignId={campaignId} settings={settings.data} />;
}

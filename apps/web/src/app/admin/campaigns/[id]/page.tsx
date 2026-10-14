import {
  BarChart3Icon,
  EyeIcon,
  FileTextIcon,
  MailPlusIcon,
  MessagesSquareIcon,
  PencilIcon,
} from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { CampaignActions } from "@/components/admin/campaigns/CampaignActions";
import { CampaignOverview, type OverviewData } from "@/components/admin/campaigns/CampaignOverview";
import { CampaignSettingsTab } from "@/components/admin/campaigns/CampaignSettingsTab";
import { CampaignTabs, tabFrom } from "@/components/admin/campaigns/CampaignTabs";
import { InvitationActions } from "@/components/admin/campaigns/InvitationActions";
import { InviteComposer } from "@/components/admin/campaigns/InviteComposer";
import { sessionRowsOf } from "@/components/admin/campaigns/sessionRows";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DateText } from "@/components/common/DateText";
import { DataTable } from "@/components/data/DataTable";
import { ExportMenu } from "@/components/data/ExportMenu";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { enumFilterDef, statusFilterDef } from "@/lib/admin/table-filters";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { LISTS, sortOf } from "@/lib/api/lists";
import type { Analysis, Campaign, Invitation, SessionListItem } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.campaigns.title };
}

type SearchParams = Record<string, string | string[] | undefined>;

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
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
        meta={<StatusBadge status={campaign.status} />}
        actions={isAdmin ? <CampaignActions campaign={campaign} /> : undefined}
        secondaryActions={
          <>
            {isAdmin ? (
              <IconButton
                label={s.edit}
                variant="outline"
                size="icon"
                icon={<PencilIcon />}
                href={`/admin/campaigns/${campaign.id}/edit`}
              />
            ) : null}
            <IconButton
              label={s.results}
              variant="outline"
              size="icon"
              icon={<BarChart3Icon />}
              href={`/admin/campaigns/${campaign.id}/results`}
            />
            <IconButton
              label={s.report}
              variant="outline"
              size="icon"
              icon={<FileTextIcon />}
              href={`/admin/campaigns/${campaign.id}/report`}
            />
          </>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
        <CampaignTabs campaignId={campaign.id} current={tab} />
        {tab === "overview" ? <Overview campaignId={id} campaign={campaign} /> : null}
        {tab === "invitations" ? <Invitations campaignId={id} searchParams={sp} isAdmin={isAdmin} /> : null}
        {tab === "sessions" ? <Sessions campaignId={id} searchParams={sp} isAdmin={isAdmin} /> : null}
        {tab === "analysis" ? <AnalysisTab campaignId={id} searchParams={sp} /> : null}
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

/** One page of a list a tab shows, or the message that says why there is none (D-361). */
async function load<T>(
  work: () => Promise<{ items: T[]; total: number | null }>,
): Promise<{ items: T[]; total: number | null; error: string | undefined }> {
  try {
    const r = await work();
    return { items: r.items, total: r.total, error: undefined };
  } catch (e) {
    return { items: [], total: 0, error: errorMessage(e, t.app.unknownError) };
  }
}

async function Invitations({
  campaignId,
  searchParams,
  isAdmin,
}: {
  campaignId: string;
  searchParams: SearchParams;
  isAdmin: boolean;
}): Promise<React.JSX.Element> {
  const api = await staffServer();
  const lp = listParams(searchParams, LISTS.invitations);
  const s = t.admin.campaigns;
  const dash = <span className="text-muted-foreground">{t.admin.common.dash}</span>;
  const { items, total, error } = await load<Invitation>(() =>
    api.campaigns.invitations(campaignId, lp.query),
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {isAdmin ? <InviteComposer campaignId={campaignId} /> : null}
      <DataTable
        id="invitations"
        label={s.invitationsTitle}
        searchLabel={isAdmin ? t.admin.list.searchInvitations : undefined}
        filters={[statusFilterDef(LISTS.invitations)]}
        sort={sortOf(LISTS.invitations)}
        error={error}
        columns={[
          {
            id: "email",
            header: s.invitationEmail,
            ...(isAdmin ? { sortKey: "email" } : {}),
            primary: true,
            locked: true,
          },
          { id: "status", header: s.invitationStatus, sortKey: "status" },
          { id: "sent", header: s.invitationSent, sortKey: "sentAt" },
          { id: "opened", header: s.invitationOpened, sortKey: "openedAt" },
        ]}
        rows={items.map((inv) => ({
          id: inv.id,
          label: inv.email ?? s.anonymousEmail,
          cells: {
            email: inv.email ? (
              <span className="text-foreground block truncate font-medium">{inv.email}</span>
            ) : (
              <span className="text-muted-foreground">{s.anonymousEmail}</span>
            ),
            status: <StatusBadge status={inv.status} />,
            sent: inv.sentAt ? <DateText iso={inv.sentAt} /> : dash,
            opened: inv.openedAt ? <DateText iso={inv.openedAt} /> : dash,
          },
          ...(isAdmin
            ? {
                actions: (
                  <InvitationActions
                    campaignId={campaignId}
                    invitationId={inv.id}
                    email={inv.email ?? null}
                    status={inv.status}
                  />
                ),
              }
            : {}),
        }))}
        page={{ page: lp.page, limit: lp.limit, count: items.length, total }}
        empty={{
          icon: <MailPlusIcon className="size-5" aria-hidden="true" />,
          title: s.invitationsEmptyTitle,
          description: isAdmin ? s.noInvitations : s.noInvitationsMember,
        }}
      />
    </div>
  );
}

async function Sessions({
  campaignId,
  searchParams,
  isAdmin,
}: {
  campaignId: string;
  searchParams: SearchParams;
  isAdmin: boolean;
}): Promise<React.JSX.Element> {
  const api = await staffServer();
  const lp = listParams(searchParams, LISTS.campaignSessions);
  const s = t.admin.campaigns;
  const { items, total, error } = await load<SessionListItem>(() =>
    api.campaigns.sessions(campaignId, lp.query),
  );
  return (
    <DataTable
      id="sessions"
      label={s.sessionsTitle}
      searchLabel={t.admin.list.searchSessions}
      filters={[
        statusFilterDef(LISTS.campaignSessions),
        enumFilterDef(LISTS.campaignSessions, "flagged", s.flagFilterLabel, (v) =>
          v === "true" ? s.flagFilterOn : s.flagFilterOff,
        ),
      ]}
      sort={sortOf(LISTS.campaignSessions)}
      error={error}
      toolbarActions={
        isAdmin ? (
          <ExportMenu
            withFilters={false}
            formats={[
              {
                id: "csv",
                label: s.exportCsv,
                description: s.exportCsvHint,
                path: `/api/staff/campaigns/${encodeURIComponent(campaignId)}/sessions.csv`,
                fallbackName: "interviews.csv",
                what: s.sessionsTitle,
              },
            ]}
          />
        ) : undefined
      }
      columns={[
        { id: "participant", header: s.sessionParticipant, primary: true, locked: true },
        { id: "status", header: s.sessionStatus, sortKey: "status" },
        { id: "mode", header: s.sessionMode },
        { id: "flag", header: s.sessionFlag },
        { id: "progress", header: s.sessionProgress },
        { id: "cost", header: s.sessionCost, align: "end" },
        { id: "updated", header: s.sessionUpdated, sortKey: "lastActivity" },
      ]}
      rows={sessionRowsOf(items)}
      page={{ page: lp.page, limit: lp.limit, count: items.length, total }}
      empty={{
        icon: <MessagesSquareIcon className="size-5" aria-hidden="true" />,
        title: s.sessionsEmptyTitle,
        description: s.noSessions,
      }}
    />
  );
}

async function AnalysisTab({
  campaignId,
  searchParams,
}: {
  campaignId: string;
  searchParams: SearchParams;
}): Promise<React.JSX.Element> {
  const api = await staffServer();
  const lp = listParams(searchParams, LISTS.analyses);
  const s = t.admin.campaigns;
  const { items, total, error } = await load<Analysis>(() => api.analyses.list(campaignId, lp.query));
  return (
    <DataTable
      id="analyses"
      label={s.analysisList}
      sort={sortOf(LISTS.analyses)}
      filters={[statusFilterDef(LISTS.analyses)]}
      error={error}
      columns={[
        { id: "version", header: s.analysisVersion, sortKey: "version", primary: true, locked: true },
        { id: "status", header: s.status },
        { id: "created", header: s.analysisCreated, sortKey: "createdAt" },
        { id: "interviews", header: s.analysisInterviews, align: "end" },
      ]}
      rows={items.map((a) => ({
        id: a.id,
        label: `v${String(a.version)}`,
        cells: {
          version: (
            <span className="text-foreground font-medium">
              v{a.version}{" "}
              {a.preliminary ? <Badge variant="outline">{t.admin.results.preliminary}</Badge> : null}
            </span>
          ),
          status: <StatusBadge status={a.status} />,
          created: <DateText iso={a.createdAt} />,
          interviews: <span className="tabular-nums">{a.stats.sessions}</span>,
        },
        actions: (
          <RowActions>
            <IconButton
              label={`${s.analysisOpenResults}: v${String(a.version)}`}
              icon={<BarChart3Icon />}
              href={`/admin/campaigns/${campaignId}/results`}
            />
            <IconButton
              label={`${s.analysisOpenReport}: v${String(a.version)}`}
              icon={<EyeIcon />}
              href={`/admin/campaigns/${campaignId}/report`}
            />
          </RowActions>
        ),
      }))}
      page={{ page: lp.page, limit: lp.limit, count: items.length, total }}
      empty={{
        icon: <BarChart3Icon className="size-5" aria-hidden="true" />,
        title: s.analysisEmptyTitle,
        description: s.analysisHistoryEmpty,
      }}
    />
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

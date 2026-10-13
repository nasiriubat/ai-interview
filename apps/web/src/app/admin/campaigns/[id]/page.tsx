import { BarChart3Icon, FileTextIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as React from "react";
import { CampaignActions } from "@/components/admin/campaigns/CampaignActions";
import { InvitationsPanel } from "@/components/admin/campaigns/InvitationsPanel";
import { SessionsTable } from "@/components/admin/campaigns/SessionsTable";
import { EmptyState } from "@/components/admin/EmptyState";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { StatTile } from "@/components/admin/StatTile";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { isFiltered, statusFilter } from "@/lib/admin/toolbar";
import { isApiError } from "@/lib/api/errors";
import { LISTS } from "@/lib/api/lists";
import { staffServer } from "@/lib/api/server";
import { humanize } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.campaigns.title };
}

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CampaignPage({ params, searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const { id } = await params;
  const lp = listParams(await searchParams, LISTS.campaignSessions);
  const { page, limit } = lp;
  const api = await staffServer();
  const [campaignR, invitationsR, sessionsR] = await Promise.allSettled([
    api.campaigns.get(id),
    api.campaigns.invitations(id),
    api.campaigns.sessions(id, lp.query),
  ]);
  if (campaignR.status === "rejected") {
    if (isApiError(campaignR.reason) && campaignR.reason.isNotFound) notFound();
    throw campaignR.reason;
  }
  const campaign = campaignR.value;
  const invitations = settled(invitationsR);
  const sessions = settled(sessionsR);
  const s = t.admin.campaigns;
  const stats = campaign.stats;
  const dropOff = Object.entries(stats?.dropOffByArea ?? {});

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
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/campaigns/${campaign.id}/results`}>
                <BarChart3Icon /> {s.results}
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/campaigns/${campaign.id}/report`}>
                <FileTextIcon /> {s.report}
              </Link>
            </Button>
          </>
        }
      />
      <div className="grid gap-6">
        <CampaignActions campaign={campaign} />

        <section aria-label={s.statsTitle} className="grid gap-3">
          <div className="grid grid-cols-3 gap-3">
            <StatTile label={s.invited} value={stats?.invited ?? t.admin.common.dash} />
            <StatTile label={s.started} value={stats?.started ?? t.admin.common.dash} />
            <StatTile label={s.completed} value={stats?.completed ?? t.admin.common.dash} />
          </div>
          {dropOff.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{s.dropOff}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.admin.templates.fields.areaName}</TableHead>
                      <TableHead className="text-right">{s.dropOff}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dropOff.map(([k, v]) => (
                      <TableRow key={k}>
                        <TableCell>{humanize(k)}</TableCell>
                        <TableCell className="text-right tabular-nums">{v}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </section>

        <Card>
          <CardHeader>
            <CardTitle>{s.invitationsTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {invitations.data ? (
              <InvitationsPanel campaignId={campaign.id} invitations={invitations.data} />
            ) : (
              <LoadError error={invitations.error} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{s.sessionsTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {sessions.data ? (
              <>
                <ListToolbar
                  searchLabel={t.admin.list.searchSessions}
                  filters={[statusFilter(LISTS.campaignSessions)]}
                  sort={{ list: LISTS.campaignSessions, labels: t.admin.list.fields }}
                />
                {sessions.data.items.length === 0 && isFiltered(lp.q, lp.filters) ? (
                  <EmptyState text={t.admin.list.noMatches} />
                ) : (
                  <SessionsTable sessions={sessions.data.items} />
                )}
                <Pagination
                  page={page}
                  limit={limit}
                  count={sessions.data.items.length}
                  total={sessions.data.total}
                />
              </>
            ) : (
              <LoadError error={sessions.error} />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

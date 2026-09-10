import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { CampaignActions } from "@/components/admin/campaigns/CampaignActions";
import { InvitationsPanel } from "@/components/admin/campaigns/InvitationsPanel";
import { SessionsTable } from "@/components/admin/campaigns/SessionsTable";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatTile } from "@/components/admin/StatTile";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";
import { humanize } from "@/lib/utils";

export const metadata: Metadata = { title: t.admin.campaigns.title };

interface Props {
  params: Promise<{ id: string }>;
}

export default async function CampaignPage({ params }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const { id } = await params;
  const api = await staffServer();
  const [campaignR, invitationsR, sessionsR] = await Promise.allSettled([
    api.campaigns.get(id),
    api.campaigns.invitations(id),
    api.campaigns.sessions(id),
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
        title={campaign.name}
        subtitle={[
          campaign.templateKey,
          campaign.verification ? s.verificationOptions[campaign.verification] : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={<StatusBadge status={campaign.status} />}
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
              <SessionsTable sessions={sessions.data} />
            ) : (
              <LoadError error={sessions.error} />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

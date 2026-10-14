import { widgetResponseToText } from "@aidp/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as React from "react";
import { FlagCallout } from "@/components/admin/campaigns/FlagCallout";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatTile } from "@/components/admin/StatTile";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { EnumLabel } from "@/components/common/EnumLabel";
import { MessageBubble } from "@/components/participant/MessageList";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { hasRole, requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";
import { formatCents, formatDate } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.sessions.transcript };
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SessionPage({ params }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  const { id } = await params;
  const api = await staffServer();
  const [sessionR, eventsR] = await Promise.allSettled([api.sessions.get(id), api.sessions.events(id)]);
  if (sessionR.status === "rejected") {
    if (isApiError(sessionR.reason) && sessionR.reason.isNotFound) notFound();
    throw sessionR.reason;
  }
  const session = sessionR.value;
  const events = settled(eventsR);
  const s = t.admin.sessions;
  const areas = session.progress?.areas ?? [];
  const done = areas.filter((a) => a.status === "covered").length;
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: s.title(session.id.slice(0, 8)) }}
        title={s.title(session.id.slice(0, 8))}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={session.status} />
            {session.campaignId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/campaigns/${session.campaignId}`}>{s.backToCampaign}</Link>
              </Button>
            ) : null}
            {session.templateKey === "requirements_discovery" ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/requirements/${session.id}`}>{s.openRequirements}</Link>
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-6">
        {session.flagged ? (
          <FlagCallout
            sessionId={session.id}
            reason={session.flagReason}
            acknowledgedAt={session.flagAckedAt}
            canAcknowledge={hasRole(me, ["admin", "platform_operator"])}
          />
        ) : null}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label={s.cost} value={formatCents(session.costCents)} />
          <StatTile
            label={t.admin.campaigns.sessionProgress}
            value={areas.length ? t.admin.campaigns.areasCovered(done, areas.length) : t.admin.common.dash}
          />
          <StatTile label={t.admin.campaigns.created} value={formatDate(session.createdAt)} />
          <StatTile label={t.admin.campaigns.sessionUpdated} value={formatDate(session.updatedAt)} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{s.transcript}</CardTitle>
          </CardHeader>
          <CardContent>
            {session.messages && session.messages.length > 0 ? (
              <div className="grid gap-3">
                {session.messages.map((m) => (
                  <div key={m.id} className="grid gap-1">
                    <MessageBubble message={{ role: m.role, content: m.content }} />
                    {m.widget && m.widgetResponse ? (
                      <p className="text-muted-foreground text-right text-xs">
                        {widgetResponseToText(m.widget, m.widgetResponse)}
                      </p>
                    ) : null}
                    {m.areaKey ? (
                      <p className="text-muted-foreground text-xs">
                        <EnumLabel kind="coverageArea" value={m.areaKey} />
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{s.transcriptHidden}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{s.events}</CardTitle>
          </CardHeader>
          <CardContent>
            {events.data ? (
              events.data.length === 0 ? (
                <p className="text-muted-foreground text-sm">{s.noEvents}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>{s.eventType}</TableHead>
                      <TableHead>{s.eventAt}</TableHead>
                      <TableHead>{s.eventPayload}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.data.map((ev, i) => (
                      <TableRow key={ev.id ?? i}>
                        <TableCell className="tabular-nums">{ev.seq ?? i + 1}</TableCell>
                        <TableCell className="font-mono text-xs">{ev.type}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {formatDate(ev.createdAt)}
                        </TableCell>
                        <TableCell className="max-w-xl">
                          <pre className="max-h-40 overflow-auto text-xs whitespace-pre-wrap">
                            {ev.payload === undefined || ev.payload === null
                              ? ""
                              : JSON.stringify(ev.payload, null, 1)}
                          </pre>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            ) : (
              <LoadError error={events.error} />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

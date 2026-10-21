import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { ErrorActions, OccurrenceList } from "@/components/admin/operator/ErrorDetail";
import { ErrorStatusBadge, SourceBadge, whereOf } from "@/components/admin/operator/ErrorsPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { Panel } from "@/components/admin/Panel";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { ApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";
import { formatDate, formatNumber } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.operator.errors.detailTitle };
}

interface Props {
  params: Promise<{ id: string }>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground mt-0.5 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** One error group: what it is, how often, and its newest occurrences (D-477). */
export default async function ErrorGroupPage({ params }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const { id } = await params;
  const api = await staffServer();
  const [detailR] = await Promise.allSettled([api.operator.errors.get(id)]);
  const detail = settled(detailR);
  if (!detail.data) {
    if (detail.error instanceof ApiError && detail.error.status === 404) notFound();
    return <LoadError error={detail.error} />;
  }
  const { group, occurrences, elsewhere } = detail.data;
  const k = t.admin.operator.errors;
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: group.name }}
        title={group.message}
        meta={
          <>
            <ErrorStatusBadge group={group} />
            <SourceBadge source={group.source} />
            <Badge variant="secondary" className="font-mono font-normal">
              {group.name}
            </Badge>
            {group.resolvedAt ? (
              <span className="text-muted-foreground text-xs">
                {k.resolvedOn(formatDate(group.resolvedAt))}
              </span>
            ) : null}
          </>
        }
        secondaryActions={<ErrorActions group={group} />}
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <Panel title={k.summary} headingLevel={2}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label={k.total} value={formatNumber(group.count)} />
            <Stat label={k.last24h} value={formatNumber(group.count24h)} />
            <Stat label={k.last7d} value={formatNumber(group.count7d)} />
            <Stat label={k.severity} value={k.severities[group.severity] ?? group.severity} />
            <Stat label={k.columns.firstSeen} value={formatDate(group.firstSeenAt)} />
            <Stat label={k.columns.lastSeen} value={formatDate(group.lastSeenAt)} />
            <Stat label={k.columns.tenant} value={group.tenantName ?? k.platform} />
            <Stat label={k.spread} value={k.elsewhere(elsewhere)} />
            <div className="col-span-2 min-w-0 sm:col-span-3 lg:col-span-4">
              <dt className="text-muted-foreground text-xs">{group.jobName ? k.job : k.route}</dt>
              <dd className="text-body mt-0.5 font-mono text-xs break-all">{whereOf(group)}</dd>
            </div>
          </dl>
        </Panel>
        <OccurrenceList group={group} occurrences={occurrences} tenantName={group.tenantName ?? null} />
      </div>
    </>
  );
}

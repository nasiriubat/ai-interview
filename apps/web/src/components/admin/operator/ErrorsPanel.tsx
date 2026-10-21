import { BugIcon, EyeIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { DataTable, type FilterDef, type SortSpec } from "@/components/data/DataTable";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import type { ErrorGroup } from "@/lib/api/schemas";
import { formatDate, formatNumber } from "@/lib/utils";

const s = (): typeof t.admin.operator.errors => t.admin.operator.errors;

/** A source as a quiet badge; the tone says nothing alarming, the label says where. */
export function SourceBadge({ source }: { source: string }): React.JSX.Element {
  return (
    <Badge variant="outline" className="font-normal">
      {s().sources[source] ?? source}
    </Badge>
  );
}

export function ErrorStatusBadge({
  group,
}: {
  group: Pick<ErrorGroup, "status" | "severity">;
}): React.JSX.Element {
  if (group.status === "resolved") return <Badge variant="secondary">{s().statuses.resolved}</Badge>;
  return (
    <Badge variant={group.severity === "warning" ? "warning" : "destructive"}>{s().statuses.open}</Badge>
  );
}

/** Where it happened: the route pattern, or the job for a worker failure. */
export function whereOf(g: Pick<ErrorGroup, "route" | "jobName">): string {
  return g.jobName ?? g.route ?? t.admin.common.dash;
}

/**
 * The error log's list (D-477): one row per group, newest first by default. The message is the
 * row's name; everything else is a column the person can hide. Rendered on the server; filters and
 * search live in the URL like every other staff list.
 */
export function ErrorsPanel({
  groups,
  page,
  filters,
  sort,
  error,
  nothingThisWeek,
}: {
  groups: ErrorGroup[];
  page: { page: number; limit: number; count: number; total: number | null };
  filters: FilterDef[];
  sort: SortSpec;
  error?: string | undefined;
  /** Nothing at all was recorded in the last 7 days, resolved or not. */
  nothingThisWeek: boolean;
}): React.JSX.Element {
  const k = s();
  return (
    <DataTable
      id="errors"
      label={k.title}
      searchLabel={k.search}
      filters={filters}
      sort={sort}
      {...(error ? { error } : {})}
      columns={[
        { id: "error", header: k.columns.error, primary: true, locked: true },
        // Source, error name and route or job sit under the message, so the row stays one line of
        // columns at a laptop's width; their own columns can be shown from the column menu.
        { id: "source", header: k.columns.source, defaultHidden: true },
        { id: "where", header: k.columns.where, defaultHidden: true },
        { id: "tenant", header: k.columns.tenant },
        { id: "count", header: k.columns.count, sortKey: "count", align: "end" },
        { id: "lastSeen", header: k.columns.lastSeen, sortKey: "lastSeenAt" },
        { id: "firstSeen", header: k.columns.firstSeen, sortKey: "firstSeenAt", defaultHidden: true },
        { id: "status", header: k.columns.status },
      ]}
      rows={groups.map((g) => ({
        id: g.id,
        label: g.message,
        cells: {
          error: (
            <div className="max-w-[30rem] min-w-0 md:max-w-[22rem] md:min-w-56 xl:max-w-[30rem]">
              <Link
                href={`/admin/operator/errors/${g.id}`}
                className="text-foreground line-clamp-2 font-medium [overflow-wrap:anywhere] hover:underline"
              >
                {g.message}
              </Link>
              <p className="mt-1 flex min-w-0 items-center gap-2">
                <SourceBadge source={g.source} />
                <span
                  className="text-muted-foreground min-w-0 font-mono text-xs [overflow-wrap:anywhere] md:truncate"
                  title={whereOf(g)}
                >
                  {g.name} · {whereOf(g)}
                </span>
              </p>
            </div>
          ),
          source: <SourceBadge source={g.source} />,
          where: (
            <span className="text-body block max-w-[12rem] truncate font-mono text-xs" title={whereOf(g)}>
              {whereOf(g)}
            </span>
          ),
          tenant: g.tenantName ? (
            <span className="block max-w-[9rem] truncate" title={g.tenantName}>
              {g.tenantName}
            </span>
          ) : (
            <span className="text-muted-foreground">{k.platform}</span>
          ),
          count: (
            <span className="tabular-nums">
              <span className="font-medium">{formatNumber(g.count)}</span>
              {g.count24h > 0 ? (
                <span className="text-muted-foreground block text-xs">
                  {k.in24h(formatNumber(g.count24h))}
                </span>
              ) : null}
            </span>
          ),
          lastSeen: (
            <span className="text-muted-foreground whitespace-nowrap">{formatDate(g.lastSeenAt)}</span>
          ),
          firstSeen: (
            <span className="text-muted-foreground whitespace-nowrap">{formatDate(g.firstSeenAt)}</span>
          ),
          status: <ErrorStatusBadge group={g} />,
        },
        actions: (
          <RowActions>
            <IconButton label={k.open(g.name)} icon={<EyeIcon />} href={`/admin/operator/errors/${g.id}`} />
          </RowActions>
        ),
      }))}
      page={page}
      empty={{
        icon: <BugIcon className="size-5" aria-hidden="true" />,
        title: nothingThisWeek ? k.emptyTitle : k.noOpenTitle,
        description: nothingThisWeek ? k.emptyBody : k.noOpenBody,
      }}
    />
  );
}

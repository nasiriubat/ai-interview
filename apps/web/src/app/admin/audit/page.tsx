import type { Metadata } from "next";
import * as React from "react";
import { AuditDetails } from "@/components/admin/audit/AuditDetails";
import { PageHeader } from "@/components/admin/PageHeader";
import { DataTable } from "@/components/data/DataTable";
import { ExportMenu } from "@/components/data/ExportMenu";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { dateRangeFilterDef } from "@/lib/admin/table-filters";
import { errorMessage } from "@/lib/api/errors";
import { LISTS, sortOf } from "@/lib/api/lists";
import type { AuditEntry } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";
import { formatDate } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.audit.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function actorOf(e: AuditEntry): string {
  if (e.actorEmail) return e.actorEmail;
  if (typeof e.actor === "string") return e.actor;
  if (e.actor && typeof e.actor === "object") {
    const a = e.actor as { email?: unknown; name?: unknown; id?: unknown };
    const first = [a.email, a.name, a.id].find((x) => typeof x === "string");
    return typeof first === "string" ? first : "";
  }
  return e.userId ?? "";
}

function targetOf(e: AuditEntry): string {
  if (typeof e.target === "string") return e.target;
  if (e.targetType || e.targetId) return [e.targetType, e.targetId].filter(Boolean).join(" ");
  if (e.target && typeof e.target === "object") return JSON.stringify(e.target);
  return "";
}

export default async function AuditPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const lp = listParams(await searchParams, LISTS.audit);
  const api = await staffServer();
  let entries: AuditEntry[] = [];
  let total: number | null = 0;
  let error: string | undefined;
  try {
    // No hidden default window: what the chips say is what was asked for.
    const result = await api.audit(lp.query);
    entries = result.items;
    total = result.total;
  } catch (e) {
    error = errorMessage(e, t.app.unknownError);
  }
  const s = t.admin.audit;
  return (
    <>
      <PageHeader title={s.title} subtitle={s.subtitle} />
      <DataTable
        id="audit"
        label={s.title}
        searchLabel={t.admin.list.searchAudit}
        sort={sortOf(LISTS.audit)}
        error={error}
        filters={[
          {
            type: "select",
            key: "action",
            label: s.area,
            options: Object.entries(s.families).map(([value, label]) => ({ value, label })),
          },
          dateRangeFilterDef(s.dateRange),
        ]}
        toolbarActions={
          <ExportMenu
            formats={[
              {
                id: "csv",
                label: s.exportCsv,
                description: s.exportCsvHint,
                path: "/api/staff/audit.csv",
                fallbackName: "audit-log.csv",
                what: s.exportWhat,
              },
            ]}
          />
        }
        columns={[
          { id: "at", header: s.at, sortKey: "createdAt", locked: true },
          { id: "actor", header: s.actor },
          { id: "action", header: s.action, sortKey: "action", primary: true },
          { id: "target", header: s.target },
        ]}
        rows={entries.map((e, i) => {
          const when = formatDate(e.createdAt ?? e.at);
          const details = e.diff ?? e.details;
          return {
            id: e.id ?? String(i),
            label: `${e.action} ${when}`,
            cells: {
              at: <span className="text-muted-foreground whitespace-nowrap">{when}</span>,
              actor: actorOf(e) || t.admin.common.dash,
              action: <span className="font-mono text-xs">{e.action}</span>,
              target: (
                <span className="font-mono text-xs break-all">{targetOf(e) || t.admin.common.dash}</span>
              ),
            },
            actions:
              details !== undefined && details !== null ? (
                <AuditDetails action={e.action} when={when} details={details} />
              ) : undefined,
          };
        })}
        page={{ page: lp.page, limit: lp.limit, count: entries.length, total }}
        empty={{ description: s.empty }}
      />
    </>
  );
}

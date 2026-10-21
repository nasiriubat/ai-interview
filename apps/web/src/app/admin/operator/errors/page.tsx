import type { Metadata } from "next";
import * as React from "react";
import { settled } from "@/components/admin/LoadError";
import { ErrorsPanel } from "@/components/admin/operator/ErrorsPanel";
import { PageHeader } from "@/components/admin/PageHeader";
import { RefreshButton } from "@/components/admin/RefreshButton";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { enumFilterDef } from "@/lib/admin/table-filters";
import type { FilterDef } from "@/lib/admin/table-state";
import { errorMessage } from "@/lib/api/errors";
import { LISTS, sortOf } from "@/lib/api/lists";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.operator.errors.title };
}

/** A menu whose empty value means `value` rather than "any": labelled so, and not offered twice. */
function withDefault(def: FilterDef, value: string): FilterDef {
  if (def.type !== "select") return def;
  const chosen = def.options.find((o) => o.value === value);
  return {
    ...def,
    options: def.options.filter((o) => o.value !== value),
    ...(chosen ? { defaultLabel: chosen.label } : {}),
  };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The built-in error log (D-477): what failed in the API, the worker, the web server and people's
 * browsers, one row per fault. With no filter it lists the open ones seen in the last 7 days.
 */
export default async function ErrorsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const lp = listParams(await searchParams, LISTS.errors);
  const api = await staffServer();
  const [listR, summaryR, tenantsR] = await Promise.allSettled([
    api.operator.errors.list(lp.query),
    api.operator.errors.summary(),
    api.operator.tenants.list({ limit: 200, sort: "name" }),
  ]);
  const list = settled(listR);
  const summary = settled(summaryR);
  const tenants = settled(tenantsR);
  const s = t.admin.operator.errors;
  const filters: FilterDef[] = [
    enumFilterDef(LISTS.errors, "source", s.filters.source, (v) => s.sources[v] ?? v),
    // With no value the API lists open groups seen in the last 7 days, so that is what the menus
    // say instead of "Any", and the default is not offered a second time.
    withDefault(
      enumFilterDef(LISTS.errors, "status", s.filters.status, (v) => s.statuses[v] ?? v),
      "open",
    ),
    withDefault(
      enumFilterDef(LISTS.errors, "period", s.filters.period, (v) => s.periods[v] ?? v),
      "7d",
    ),
    {
      type: "select",
      key: "tenant",
      label: s.columns.tenant,
      options: [
        { value: "platform", label: s.platform },
        ...(tenants.data?.items ?? []).map((tn) => ({ value: tn.id, label: tn.name })),
      ],
    },
  ];
  return (
    <>
      <PageHeader title={s.title} subtitle={s.subtitle} actions={<RefreshButton />} />
      <ErrorsPanel
        groups={list.data?.items ?? []}
        page={{
          page: lp.page,
          limit: lp.limit,
          count: list.data?.items.length ?? 0,
          total: list.data?.total ?? null,
        }}
        filters={filters}
        sort={sortOf(LISTS.errors)}
        error={list.error ? errorMessage(list.error, t.app.unknownError) : undefined}
        nothingThisWeek={summary.data ? summary.data.last7d === 0 : false}
      />
    </>
  );
}

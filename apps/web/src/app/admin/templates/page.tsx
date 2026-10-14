import { CopyIcon, EyeIcon, FileTextIcon, PencilIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DataTable } from "@/components/data/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { enumFilterDef, statusFilterDef } from "@/lib/admin/table-filters";
import { errorMessage } from "@/lib/api/errors";
import { LISTS, sortOf } from "@/lib/api/lists";
import type { TemplateListItem } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";
import { formatDate } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.templates.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TemplatesPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  const isAdmin = me?.user.role === "admin" || me?.user.role === "platform_operator";
  const lp = listParams(await searchParams, LISTS.templates);
  const api = await staffServer();
  let templates: TemplateListItem[] = [];
  let total: number | null = 0;
  let error: string | undefined;
  try {
    const result = await api.templates.page(lp.query);
    templates = result.items;
    total = result.total;
  } catch (e) {
    error = errorMessage(e, t.app.unknownError);
  }
  const s = t.admin.templates;
  const newButton = (
    <Button asChild size="sm">
      <Link href="/admin/templates/new">
        <PlusIcon aria-hidden="true" /> {s.new}
      </Link>
    </Button>
  );
  return (
    <>
      <PageHeader
        title={s.title}
        subtitle={s.subtitle}
        actions={
          <Button asChild>
            <Link href="/admin/templates/new">
              <PlusIcon aria-hidden="true" /> {s.new}
            </Link>
          </Button>
        }
      />
      <DataTable
        id="templates"
        label={s.title}
        searchLabel={t.admin.list.searchTemplates}
        filters={[
          statusFilterDef(LISTS.templates),
          enumFilterDef(
            LISTS.templates,
            "origin",
            t.admin.list.fields.origin ?? "Origin",
            (v) => t.admin.list.origins[v] ?? v,
          ),
        ]}
        sort={sortOf(LISTS.templates)}
        error={error}
        columns={[
          { id: "name", header: s.name, sortKey: "name", primary: true, locked: true },
          { id: "key", header: s.key, sortKey: "key" },
          { id: "version", header: s.version },
          { id: "owner", header: s.owner },
          { id: "status", header: s.status },
          { id: "updated", header: t.admin.list.fields.updatedAt ?? "Updated", sortKey: "updatedAt" },
        ]}
        rows={templates.map((tpl) => ({
          id: tpl.id,
          label: tpl.name,
          cells: {
            name: (
              <Link
                href={`/admin/templates/${tpl.id}`}
                className="text-foreground font-medium hover:underline"
              >
                {tpl.name}
              </Link>
            ),
            key: <span className="font-mono text-xs">{tpl.key}</span>,
            version: <span className="tabular-nums">v{tpl.version}</span>,
            owner: (
              <Badge variant={tpl.companyId ? "secondary" : "outline"}>
                {tpl.companyId ? s.tenant : s.platform}
              </Badge>
            ),
            status: <StatusBadge status={tpl.status} />,
            updated: (
              <span className="text-muted-foreground whitespace-nowrap">{formatDate(tpl.updatedAt)}</span>
            ),
          },
          actions: (
            <RowActions>
              <IconButton
                label={`${t.admin.actions.view}: ${tpl.name}`}
                icon={<EyeIcon />}
                href={`/admin/templates/${tpl.id}`}
              />
              {isAdmin && tpl.companyId ? (
                <IconButton
                  label={`${s.edit}: ${tpl.name}`}
                  icon={<PencilIcon />}
                  href={`/admin/templates/${tpl.id}/edit`}
                />
              ) : null}
              {isAdmin ? (
                <IconButton
                  label={`${s.copy}: ${tpl.name}`}
                  icon={<CopyIcon />}
                  href={`/admin/templates/new?copyFrom=${tpl.id}`}
                />
              ) : null}
            </RowActions>
          ),
        }))}
        page={{ page: lp.page, limit: lp.limit, count: templates.length, total }}
        empty={{
          icon: <FileTextIcon className="size-5" aria-hidden="true" />,
          title: s.emptyTitle,
          description: s.empty,
          action: newButton,
        }}
      />
    </>
  );
}

import { PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { enumFilter, isFiltered, statusFilter } from "@/lib/admin/toolbar";
import { LISTS } from "@/lib/api/lists";
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
  await requireMe();
  const lp = listParams(await searchParams, LISTS.templates);
  const api = await staffServer();
  const result = await api.templates.page(lp.query);
  const templates = result.items;
  const s = t.admin.templates;
  return (
    <>
      <PageHeader
        title={s.title}
        subtitle={s.subtitle}
        actions={
          <Button asChild>
            <Link href="/admin/templates/new">
              <PlusIcon /> {s.new}
            </Link>
          </Button>
        }
      />
      <ListToolbar
        searchLabel={t.admin.list.searchTemplates}
        filters={[
          statusFilter(LISTS.templates),
          enumFilter(
            LISTS.templates,
            "origin",
            t.admin.list.fields.origin ?? "Origin",
            t.admin.list.allOrigins,
            (v) => t.admin.list.origins[v] ?? v,
          ),
        ]}
        sort={{ list: LISTS.templates, labels: t.admin.list.fields }}
      />
      {templates.length === 0 ? (
        <EmptyState text={isFiltered(lp.q, lp.filters) ? t.admin.list.noMatches : s.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{s.name}</TableHead>
              <TableHead>{s.key}</TableHead>
              <TableHead>{s.version}</TableHead>
              <TableHead>{s.owner}</TableHead>
              <TableHead>{s.status}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((tpl) => (
              <TableRow key={tpl.id}>
                <TableCell className="font-medium">
                  <Link href={`/admin/templates/${tpl.id}`} className="hover:underline">
                    {tpl.name}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{tpl.key}</TableCell>
                <TableCell>v{tpl.version}</TableCell>
                <TableCell>
                  <Badge variant={tpl.companyId ? "secondary" : "outline"}>
                    {tpl.companyId ? s.tenant : s.platform}
                  </Badge>
                </TableCell>
                <TableCell>
                  <StatusBadge status={tpl.status} />
                </TableCell>
                <TableCell className="text-muted-foreground text-right text-xs">
                  {formatDate(tpl.updatedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pagination page={lp.page} limit={lp.limit} count={templates.length} total={result.total} />
    </>
  );
}

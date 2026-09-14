import { EyeIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { pageParams } from "@/lib/admin/pagination";
import { staffServer } from "@/lib/api/server";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.requirements.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RequirementsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const { page, limit, offset } = pageParams(await searchParams);
  const api = await staffServer();
  const result = await api.requirements.list({ limit, offset });
  const sessions = result.items;
  const s = t.admin.requirements;
  return (
    <>
      <PageHeader
        title={s.title}
        subtitle={s.subtitle}
        actions={
          <Button asChild>
            <Link href="/admin/requirements/new">
              <PlusIcon /> {s.new}
            </Link>
          </Button>
        }
      />
      {sessions.length === 0 ? (
        <EmptyState text={s.empty}>
          <Button asChild variant="outline">
            <Link href="/admin/requirements/new">{s.new}</Link>
          </Button>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.columns.title}</TableHead>
                <TableHead>{s.columns.status}</TableHead>
                <TableHead>{s.columns.path}</TableHead>
                <TableHead>{s.columns.owner}</TableHead>
                <TableHead className="text-right">{s.columns.versions}</TableHead>
                <TableHead className="text-right">{s.columns.openFindings}</TableHead>
                <TableHead>{s.columns.created}</TableHead>
                <TableHead className="text-right">{t.admin.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    <Link href={`/admin/requirements/${r.id}`} className="hover:underline">
                      {r.title || t.admin.common.unnamed}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell>{r.path ? s.paths[r.path] : t.admin.common.dash}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {r.ownerEmail ?? r.ownerUserId ?? t.admin.common.dash}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.versions}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.openFindings}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatDate(r.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <RowActions>
                      <IconButton
                        label={t.admin.actions.view}
                        icon={EyeIcon}
                        href={`/admin/requirements/${r.id}`}
                      />
                    </RowActions>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={page} limit={limit} count={sessions.length} total={result.total} />
    </>
  );
}

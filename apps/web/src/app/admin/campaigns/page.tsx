import { BarChart3Icon, EyeIcon, PlusIcon } from "lucide-react";
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

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.campaigns.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CampaignsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const { page, limit, offset } = pageParams(await searchParams);
  const api = await staffServer();
  const result = await api.campaigns.list({ limit, offset });
  const campaigns = result.items;
  const s = t.admin.campaigns;
  return (
    <>
      <PageHeader
        title={s.title}
        subtitle={s.subtitle}
        actions={
          <Button asChild>
            <Link href="/admin/campaigns/new">
              <PlusIcon /> {s.new}
            </Link>
          </Button>
        }
      />
      {campaigns.length === 0 ? (
        <EmptyState text={s.empty} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{s.name}</TableHead>
                <TableHead>{s.status}</TableHead>
                <TableHead className="text-right">{s.invited}</TableHead>
                <TableHead className="text-right">{s.started}</TableHead>
                <TableHead className="text-right">{s.completed}</TableHead>
                <TableHead>{s.created}</TableHead>
                <TableHead className="text-right">{t.admin.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    <Link href={`/admin/campaigns/${c.id}`} className="hover:underline">
                      {c.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.stats?.invited ?? t.admin.common.dash}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.stats?.started ?? t.admin.common.dash}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.stats?.completed ?? t.admin.common.dash}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{formatDate(c.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <RowActions>
                      <IconButton
                        label={t.admin.actions.view}
                        icon={<EyeIcon />}
                        href={`/admin/campaigns/${c.id}`}
                      />
                      <IconButton
                        label={s.results}
                        icon={<BarChart3Icon />}
                        href={`/admin/campaigns/${c.id}/results`}
                      />
                    </RowActions>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={page} limit={limit} count={campaigns.length} total={result.total} />
    </>
  );
}

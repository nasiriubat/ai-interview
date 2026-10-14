import { BarChart3Icon, EyeIcon, MegaphoneIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { DataTable } from "@/components/data/DataTable";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { statusFilterDef } from "@/lib/admin/table-filters";
import { errorMessage } from "@/lib/api/errors";
import { LISTS, sortOf } from "@/lib/api/lists";
import type { Campaign } from "@/lib/api/schemas";
import { staffServer } from "@/lib/api/server";
import { formatDate } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.campaigns.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CampaignsPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const lp = listParams(await searchParams, LISTS.campaigns);
  const api = await staffServer();
  let campaigns: Campaign[] = [];
  let total: number | null = 0;
  let error: string | undefined;
  try {
    const result = await api.campaigns.list(lp.query);
    campaigns = result.items;
    total = result.total;
  } catch (e) {
    error = errorMessage(e, t.app.unknownError);
  }
  const s = t.admin.campaigns;
  const dash = t.admin.common.dash;
  return (
    <>
      <PageHeader
        title={s.title}
        subtitle={s.subtitle}
        actions={
          <Button asChild>
            <Link href="/admin/campaigns/new">
              <PlusIcon aria-hidden="true" /> {s.new}
            </Link>
          </Button>
        }
      />
      <DataTable
        id="campaigns"
        label={s.title}
        searchLabel={t.admin.list.searchCampaigns}
        filters={[statusFilterDef(LISTS.campaigns)]}
        sort={sortOf(LISTS.campaigns)}
        error={error}
        columns={[
          { id: "name", header: s.name, sortKey: "name", primary: true, locked: true },
          { id: "status", header: s.status, sortKey: "status" },
          { id: "invited", header: s.invited, align: "end" },
          { id: "started", header: s.started, align: "end" },
          { id: "completed", header: s.completed, align: "end" },
          { id: "created", header: s.created, sortKey: "createdAt" },
        ]}
        rows={campaigns.map((c) => ({
          id: c.id,
          label: c.name,
          cells: {
            name: (
              <Link href={`/admin/campaigns/${c.id}`} className="text-foreground font-medium hover:underline">
                {c.name}
              </Link>
            ),
            status: <StatusBadge status={c.status} />,
            invited: c.stats?.invited ?? dash,
            started: c.stats?.started ?? dash,
            completed: c.stats?.completed ?? dash,
            created: <span className="text-muted-foreground">{formatDate(c.createdAt)}</span>,
          },
          actions: (
            <RowActions>
              <IconButton
                label={`${t.admin.actions.view}: ${c.name}`}
                icon={<EyeIcon />}
                href={`/admin/campaigns/${c.id}`}
              />
              <IconButton
                label={`${s.results}: ${c.name}`}
                icon={<BarChart3Icon />}
                href={`/admin/campaigns/${c.id}/results`}
              />
            </RowActions>
          ),
        }))}
        page={{ page: lp.page, limit: lp.limit, count: campaigns.length, total }}
        empty={{
          icon: <MegaphoneIcon className="size-5" aria-hidden="true" />,
          title: s.emptyTitle,
          description: s.empty,
          action: (
            <Button asChild size="sm">
              <Link href="/admin/campaigns/new">
                <PlusIcon aria-hidden="true" /> {s.new}
              </Link>
            </Button>
          ),
        }}
      />
    </>
  );
}

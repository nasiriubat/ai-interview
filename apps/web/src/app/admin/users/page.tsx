import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { UsersPanel } from "@/components/admin/users/UsersPanel";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { hasRole, requireMe } from "@/lib/admin/me";
import { pageParams } from "@/lib/admin/pagination";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.users.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsersPage({ searchParams }: Props): Promise<React.JSX.Element> {
  const me = await requireMe();
  const { page, limit, offset } = pageParams(await searchParams);
  const api = await staffServer();
  const result = await api.users.list({ limit, offset });
  return (
    <>
      <PageHeader title={t.admin.users.title} subtitle={t.admin.users.subtitle} />
      <UsersPanel users={result.items} canEdit={hasRole(me, ["admin", "platform_operator"])} />
      <Pagination page={page} limit={limit} count={result.items.length} total={result.total} />
    </>
  );
}

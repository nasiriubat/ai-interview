import type { Metadata } from "next";
import * as React from "react";
import { ListToolbar } from "@/components/admin/ListToolbar";
import { PageHeader } from "@/components/admin/PageHeader";
import { Pagination } from "@/components/admin/Pagination";
import { UsersPanel } from "@/components/admin/users/UsersPanel";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { hasRole, requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { enumFilter } from "@/lib/admin/toolbar";
import { LISTS, sortOf } from "@/lib/api/lists";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.users.title };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsersPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  const lp = listParams(await searchParams, LISTS.users);
  const { page, limit } = lp;
  const api = await staffServer();
  const result = await api.users.list(lp.query);
  return (
    <>
      <PageHeader title={t.admin.users.title} subtitle={t.admin.users.subtitle} />
      <ListToolbar
        searchLabel={t.admin.list.searchUsers}
        filters={[
          enumFilter(LISTS.users, "role", t.admin.list.fields.role ?? "Role", t.admin.list.allRoles, (v) =>
            v in t.admin.nav.role ? t.admin.nav.role[v as keyof typeof t.admin.nav.role] : v,
          ),
        ]}
        sort={{ list: sortOf(LISTS.users), labels: t.admin.list.fields }}
      />
      <UsersPanel
        users={result.items}
        canEdit={hasRole(me, ["admin", "platform_operator"])}
        currentUserId={me?.user.id}
      />
      <Pagination page={page} limit={limit} count={result.items.length} total={result.total} />
    </>
  );
}

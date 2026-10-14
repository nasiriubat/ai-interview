import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { UsersPanel } from "@/components/admin/users/UsersPanel";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { hasRole, requireMe } from "@/lib/admin/me";
import { listParams } from "@/lib/admin/pagination";
import { enumFilterDef } from "@/lib/admin/table-filters";
import { errorMessage } from "@/lib/api/errors";
import { LISTS, sortOf } from "@/lib/api/lists";
import type { User } from "@/lib/api/schemas";
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
  const api = await staffServer();
  let users: User[] = [];
  let total: number | null = 0;
  let error: string | undefined;
  try {
    const result = await api.users.list(lp.query);
    users = result.items;
    total = result.total;
  } catch (e) {
    error = errorMessage(e, t.app.unknownError);
  }
  return (
    <>
      <PageHeader title={t.admin.users.title} subtitle={t.admin.users.subtitle} />
      <UsersPanel
        users={users}
        canEdit={hasRole(me, ["admin", "platform_operator"])}
        currentUserId={me?.user.id}
        page={{ page: lp.page, limit: lp.limit, count: users.length, total }}
        filters={[
          enumFilterDef(LISTS.users, "role", t.admin.list.fields.role ?? "Role", (v) =>
            v in t.admin.nav.role ? t.admin.nav.role[v as keyof typeof t.admin.nav.role] : v,
          ),
        ]}
        sort={sortOf(LISTS.users)}
        error={error}
      />
    </>
  );
}

import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { UsersPanel } from "@/components/admin/users/UsersPanel";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { hasRole, requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.users.title };
}

export default async function UsersPage(): Promise<React.JSX.Element> {
  const me = await requireMe();
  const api = await staffServer();
  const users = await api.users.list();
  return (
    <>
      <PageHeader title={t.admin.users.title} subtitle={t.admin.users.subtitle} />
      <UsersPanel users={users} canEdit={hasRole(me, ["admin", "platform_operator"])} />
    </>
  );
}

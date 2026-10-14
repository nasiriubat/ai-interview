import type { Metadata } from "next";
import * as React from "react";
import { signOutAction } from "../actions";
import { AccountForms } from "@/components/admin/account/AccountForms";
import { PageHeader } from "@/components/admin/PageHeader";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).kit.account.title };
}

export default async function AccountPage(): Promise<React.JSX.Element> {
  await requestLocale();
  const me = await requireMe();
  return (
    <>
      <PageHeader title={t.kit.account.title} subtitle={t.kit.account.subtitle} />
      {me ? <AccountForms me={me} signOutAction={signOutAction} /> : null}
    </>
  );
}

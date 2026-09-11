import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { RequirementsForm } from "@/components/admin/requirements/RequirementsForm";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.requirements.create.title };
}

const REQUIREMENTS_TEMPLATE_KEY = "requirements_discovery";

export default async function NewRequirementsPage(): Promise<React.JSX.Element> {
  await requireMe();
  const api = await staffServer();
  let templates: Awaited<ReturnType<typeof api.templates.list>> = [];
  try {
    templates = (await api.templates.list()).filter(
      (tpl) => tpl.key === REQUIREMENTS_TEMPLATE_KEY && tpl.status === "published",
    );
  } catch {
    // The API picks the shipped template when none is sent.
  }
  const s = t.admin.requirements.create;
  return (
    <>
      <PageHeader title={s.title} subtitle={s.body} />
      <RequirementsForm templates={templates} />
    </>
  );
}

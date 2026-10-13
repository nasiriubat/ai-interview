import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { TemplateForm } from "@/components/admin/templates/TemplateForm";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { toTemplateInput } from "@/lib/admin/template";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.templates.title };
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditTemplatePage({ params }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const { id } = await params;
  const api = await staffServer();
  let tpl;
  try {
    tpl = await api.templates.get(id);
  } catch (e) {
    if (isApiError(e) && e.isNotFound) notFound();
    throw e;
  }
  const initial = toTemplateInput(tpl);
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: tpl.name }}
        title={t.admin.templates.editTitle(tpl.name)}
        subtitle={`${tpl.key} · v${tpl.version}`}
      />
      <TemplateForm initial={{ ...initial, version: tpl.version + 1 }} templateId={tpl.id} />
    </>
  );
}

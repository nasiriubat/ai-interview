import type { Metadata } from "next";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { emptyTemplate, TemplateForm } from "@/components/admin/templates/TemplateForm";
import { t } from "@/i18n";
import { requireMe } from "@/lib/admin/me";
import { toTemplateInput } from "@/lib/admin/template";
import { staffServer } from "@/lib/api/server";

export const metadata: Metadata = { title: t.admin.templates.createTitle };

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NewTemplatePage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const sp = await searchParams;
  const copyFrom = typeof sp.copyFrom === "string" ? sp.copyFrom : undefined;
  let initial = emptyTemplate;
  if (copyFrom) {
    const api = await staffServer();
    const source = await api.templates.get(copyFrom);
    const rest = toTemplateInput(source);
    initial = { ...rest, key: `${rest.key}_copy`, version: 1 };
  }
  return (
    <>
      <PageHeader title={t.admin.templates.createTitle} />
      <TemplateForm initial={initial} copyFromId={copyFrom} />
    </>
  );
}

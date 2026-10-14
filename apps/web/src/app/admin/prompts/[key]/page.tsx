import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { promptDescription, promptName } from "@/components/admin/prompts/PromptsTable";
import { PromptWorkspace } from "@/components/admin/prompts/PromptWorkspace";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.prompts.title };
}

interface Props {
  params: Promise<{ key: string }>;
}

export default async function PromptPage({ params }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const { key } = await params;
  const api = await staffServer();
  let detail;
  try {
    detail = await api.prompts.get(key);
  } catch (e) {
    if (isApiError(e) && e.isNotFound) notFound();
    throw e;
  }
  return (
    <>
      <PageHeader
        crumbLabels={{ [key]: promptName(key) }}
        title={promptName(key)}
        subtitle={promptDescription(key)}
      />
      <PromptWorkspace detail={detail} />
    </>
  );
}

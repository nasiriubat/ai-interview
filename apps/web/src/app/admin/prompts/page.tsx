import { FlaskConicalIcon } from "lucide-react";
import type { Metadata } from "next";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { PromptsTable } from "@/components/admin/prompts/PromptsTable";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { staffServer } from "@/lib/api/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.prompts.title };
}

export default async function PromptsPage(): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const api = await staffServer();
  const [listR] = await Promise.allSettled([api.prompts.list()]);
  const list = settled(listR);
  const s = t.admin.prompts;
  return (
    <>
      <PageHeader title={s.title} subtitle={s.subtitle} />
      <div className="grid gap-6">
        <Alert variant="warning" role="status">
          <FlaskConicalIcon aria-hidden="true" />
          <AlertTitle>{s.warningTitle}</AlertTitle>
          <AlertDescription>
            <p>{s.warningBody}</p>
            <p>
              {s.evalsDocPrefix} <code>{s.evalsDoc}</code> {s.evalsDocSuffix}
            </p>
          </AlertDescription>
        </Alert>
        {list.data ? (
          <PromptsTable prompts={list.data.prompts} windowDays={list.data.windowDays} />
        ) : (
          <LoadError error={list.error} />
        )}
      </div>
    </>
  );
}

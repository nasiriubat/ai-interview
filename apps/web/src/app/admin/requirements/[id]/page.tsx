import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as React from "react";
import { PageHeader } from "@/components/admin/PageHeader";
import { RequirementsWorkspace } from "@/components/admin/requirements/RequirementsWorkspace";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";
import { sourceLabel } from "@/lib/requirements/labels";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).admin.requirements.title };
}

interface Props {
  params: Promise<{ id: string }>;
}

export default async function RequirementsSessionPage({ params }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const { id } = await params;
  const api = await staffServer();
  let detail;
  try {
    detail = await api.requirements.get(id);
  } catch (e) {
    if (isApiError(e) && e.isNotFound) notFound();
    throw e;
  }
  const s = t.admin.requirements;
  const subtitle = [
    detail.session.path ? s.paths[detail.session.path] : null,
    sourceLabel(detail.session.sourceKind),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <PageHeader
        crumbLabels={{ [id]: detail.session.title || t.admin.common.unnamed }}
        title={detail.session.title || t.admin.common.unnamed}
        subtitle={subtitle || undefined}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/requirements">
              <ArrowLeftIcon /> {s.workspace.backToList}
            </Link>
          </Button>
        }
      />
      <RequirementsWorkspace initial={detail} />
    </>
  );
}

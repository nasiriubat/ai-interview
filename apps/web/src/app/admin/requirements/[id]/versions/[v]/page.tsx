import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import * as React from "react";
import { LoadError, settled } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { VersionView } from "@/components/admin/requirements/VersionView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { v } = await params;
  return { title: (await getStrings()).admin.requirements.version.title(Number(v)) };
}

interface Props {
  params: Promise<{ id: string; v: string }>;
}

export default async function SpecVersionPage({ params }: Props): Promise<React.JSX.Element> {
  await requireMe();
  const { id, v } = await params;
  const api = await staffServer();
  const [detailR, listR] = await Promise.allSettled([
    api.requirements.versions.get(id, v),
    api.requirements.versions.list(id),
  ]);
  if (detailR.status === "rejected") {
    if (isApiError(detailR.reason) && detailR.reason.isNotFound) notFound();
    throw detailR.reason;
  }
  const detail = detailR.value;
  const list = settled(listR);
  const others = (list.data ?? []).filter((x) => x.id !== detail.version.id && x.status === "done");
  const s = t.admin.requirements.version;
  return (
    <>
      <PageHeader
        title={s.title(detail.version.version)}
        subtitle={detail.version.label ?? undefined}
        actions={
          <Button asChild variant="outline">
            <Link href={`/admin/requirements/${id}`}>
              <ArrowLeftIcon /> {s.backToSession}
            </Link>
          </Button>
        }
      />
      {list.error ? <LoadError error={list.error} /> : null}
      <VersionView sessionId={id} initial={detail} others={others} />
    </>
  );
}

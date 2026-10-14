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
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isVersionNumber } from "@/lib/admin/validation";
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
  await requestLocale();
  await requireMe();
  const { id, v } = await params;
  // A version is a positive number; anything else ("latest", a typo) is a missing page, not the
  // 500 the API's validation error used to become (simulation 2026-10-15).
  if (!isVersionNumber(v)) notFound();
  const api = await staffServer();
  const [detailR, listR, sessionR] = await Promise.allSettled([
    api.requirements.versions.get(id, v),
    api.requirements.versions.list(id),
    api.requirements.get(id),
  ]);
  // The trail named the interview "Details" (simulation 2026-10-15); it is the interview's title.
  const sessionTitle = sessionR.status === "fulfilled" ? sessionR.value.session.title : "";
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
        crumbLabels={{ [id]: sessionTitle || t.admin.common.unnamed, [v]: s.title(detail.version.version) }}
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

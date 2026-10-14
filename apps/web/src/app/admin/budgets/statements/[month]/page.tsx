import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileSpreadsheetIcon } from "lucide-react";
import * as React from "react";
import { StatementView } from "@/components/admin/billing/StatementView";
import { LoadError } from "@/components/admin/LoadError";
import { PageHeader } from "@/components/admin/PageHeader";
import { DownloadButton } from "@/components/data/DownloadButton";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { requireMe } from "@/lib/admin/me";
import { isApiError } from "@/lib/api/errors";
import { staffServer } from "@/lib/api/server";
import { formatMonth } from "@/lib/format";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).ws.statements.title };
}

interface Props {
  params: Promise<{ month: string }>;
}

export default async function StatementPage({ params }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  await requireMe();
  const { month } = await params;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) notFound();
  const api = await staffServer();
  let statement = null;
  let error: unknown = null;
  try {
    statement = await api.statements.get(month);
  } catch (e) {
    if (isApiError(e) && e.isNotFound) notFound();
    error = e;
  }
  const s = t.ws.statements;
  return (
    <>
      <PageHeader
        crumbLabels={{ [month]: formatMonth(month) }}
        title={`${s.title}: ${formatMonth(month)}`}
        subtitle={s.detailSubtitle}
        secondaryActions={
          <Button asChild variant="outline">
            <Link href="/admin/budgets/statements">
              <FileSpreadsheetIcon /> {s.title}
            </Link>
          </Button>
        }
        actions={
          statement ? (
            <DownloadButton
              label={`CSV: ${formatMonth(month)}`}
              text={s.downloadCsv}
              variant="outline"
              path={`/api/staff/spend/statements/${month}?format=csv`}
              fallbackName={`statement-${month}.csv`}
              what="CSV"
            />
          ) : undefined
        }
      />
      {statement ? <StatementView statement={statement} /> : <LoadError error={error} />}
    </>
  );
}

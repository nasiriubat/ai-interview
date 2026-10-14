import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

/** The report while it loads: the options column and the paper, in the shapes they will have. */
export default async function ReportLoading(): Promise<React.JSX.Element> {
  await requestLocale();
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{t.app.loading}</span>
      <Skeleton className="h-7 w-64 max-w-full" />
      <Skeleton className="mt-2 mb-6 h-4 w-96 max-w-full" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[19rem_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Skeleton className="h-44 rounded-lg" />
          <Skeleton className="h-80 rounded-lg" />
        </div>
        <div className="bg-muted/60 rounded-xl p-6">
          <Skeleton className="mx-auto h-[36rem] w-full max-w-[52rem] rounded-md" />
        </div>
      </div>
    </div>
  );
}

import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

/**
 * The results workspace while the analysis loads (D-372): the same shapes as the loaded page, so
 * the run bar, the tiles and the charts land where the eye already is and nothing jumps.
 */
export default async function ResultsLoading(): Promise<React.JSX.Element> {
  await requestLocale();
  return (
    <div aria-busy="true" aria-live="polite" className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <span className="sr-only">{t.app.loading}</span>
      <div>
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="mt-2 h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-[4.5rem] w-full rounded-lg" />
      <div className="flex gap-6 border-b pb-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-5 w-24" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-2">
        <Skeleton className="h-56 rounded-lg" />
        <Skeleton className="h-56 rounded-lg" />
      </div>
      <Skeleton className="h-96 rounded-lg" />
    </div>
  );
}

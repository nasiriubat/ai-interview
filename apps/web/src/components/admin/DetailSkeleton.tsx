import * as React from "react";
import { DataTableSkeleton } from "@/components/data/DataTable";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";

/**
 * The loading state of a detail page (D-364): a title and actions, an optional tab strip, then
 * panels or a table, in the proportions the page has once it arrives so nothing jumps. Used by the
 * route's `loading.tsx`; `table` swaps the panels for a table skeleton.
 */
export function DetailSkeleton({
  tabs = false,
  table = false,
}: {
  tabs?: boolean;
  table?: boolean;
}): React.JSX.Element {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{t.app.loading}</span>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-2">
          <Skeleton className="h-7 w-72 max-w-full" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="size-9" />
          <Skeleton className="size-9" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
      {tabs ? <Skeleton className="mb-6 h-10 w-full max-w-md" /> : null}
      {table ? (
        <DataTableSkeleton columns={4} rows={6} />
      ) : (
        <div className="grid gap-6">
          <Skeleton className="h-40 w-full rounded-lg" />
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-48 rounded-lg" />
            <Skeleton className="h-48 rounded-lg" />
          </div>
        </div>
      )}
    </div>
  );
}

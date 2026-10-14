import * as React from "react";
import { DataTableSkeleton } from "@/components/data/DataTable";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

/**
 * Shown by every admin route while its server component loads (the nearest `loading.tsx` wins, and
 * this is the only one under /admin). Shaped like most admin pages, a title over a table, so the
 * content that replaces it lands where the eye already is rather than jumping.
 */
export default async function AdminLoading(): Promise<React.JSX.Element> {
  await requestLocale();
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{t.app.loading}</span>
      <Skeleton className="h-7 w-64" />
      <Skeleton className="mt-2 mb-6 h-4 w-96 max-w-full" />
      <DataTableSkeleton columns={4} rows={8} />
    </div>
  );
}

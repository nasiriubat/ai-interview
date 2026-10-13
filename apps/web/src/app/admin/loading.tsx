import * as React from "react";
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
      <Skeleton className="mb-3 h-3.5 w-40" />
      <Skeleton className="h-7 w-64" />
      <Skeleton className="mt-2 mb-6 h-4 w-96 max-w-full" />
      <div className="bg-card shadow-card overflow-hidden rounded-lg">
        <div className="bg-muted/60 flex gap-6 border-b px-4 py-3">
          {[40, 24, 16, 20].map((w, i) => (
            <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} />
          ))}
        </div>
        {Array.from({ length: 8 }, (_, row) => (
          <div key={row} className="flex gap-6 border-b px-4 py-3.5 last:border-0">
            {[40, 24, 16, 20].map((w, i) => (
              <Skeleton key={i} className="h-4" style={{ width: `${w - ((row + i) % 3) * 4}%` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

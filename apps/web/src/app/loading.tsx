import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

export default async function Loading(): Promise<React.JSX.Element> {
  await requestLocale();
  return (
    <main id="main" className="mx-auto max-w-2xl space-y-4 p-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">{t.app.loading}</span>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-32 w-full" />
    </main>
  );
}

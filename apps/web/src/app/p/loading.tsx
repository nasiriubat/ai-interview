import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { requestLocale } from "@/i18n/server";

export default async function ParticipantLoading(): Promise<React.JSX.Element> {
  await requestLocale();
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 p-6"
      aria-busy="true"
    >
      <span className="sr-only">{t.app.loading}</span>
      <Skeleton className="h-8 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="mt-4 h-11 w-full" />
    </main>
  );
}

import * as React from "react";
import { DetailSkeleton } from "@/components/admin/DetailSkeleton";
import { requestLocale } from "@/i18n/server";

export default async function PromptsLoading(): Promise<React.JSX.Element> {
  await requestLocale();
  return <DetailSkeleton table />;
}

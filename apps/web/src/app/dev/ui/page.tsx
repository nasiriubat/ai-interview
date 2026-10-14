import { notFound } from "next/navigation";
import * as React from "react";
import { UiGallery } from "@/components/dev/UiGallery";
import { requestLocale } from "@/i18n/server";

export const dynamic = "force-dynamic";

/**
 * The UI kit gallery (D-348): dev servers and the e2e build only. A production deployment answers
 * 404, so the page is neither reachable nor indexed.
 */
export default async function GalleryPage(): Promise<React.JSX.Element> {
  await requestLocale();
  if (process.env.NODE_ENV === "production" && process.env.UI_GALLERY !== "1") notFound();
  return <UiGallery />;
}

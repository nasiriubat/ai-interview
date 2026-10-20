import type { Metadata } from "next";
import * as React from "react";
import { PilotPage } from "@/components/pilot/PilotPage";
import { stringsFor } from "@/i18n";
import { requestLocale } from "@/i18n/server";
import { getBranding } from "@/lib/branding";

/**
 * "Request a pilot" (`/pilot`): public, no sign-in. The landing page's buttons lead here. The form
 * posts to `/api/pilot`, which relays to the API; the API emails the operator (see the API's
 * `modules/pilot`). The product name comes from the platform branding (D-430).
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const s = stringsFor(await requestLocale());
  const { productName } = await getBranding();
  return {
    title: { absolute: s.pilot.meta.title(productName) },
    description: s.pilot.meta.description,
    robots: { index: true, follow: true },
    alternates: { canonical: "/pilot" },
  };
}

export default async function Page(): Promise<React.JSX.Element> {
  const locale = await requestLocale();
  const branding = await getBranding();
  return <PilotPage strings={stringsFor(locale).pilot} branding={branding} />;
}

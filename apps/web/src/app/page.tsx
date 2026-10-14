import type { Metadata } from "next";
import { headers } from "next/headers";
import * as React from "react";
import { Landing } from "@/components/landing/Landing";
import { stringsFor } from "@/i18n";
import { requestLocale } from "@/i18n/server";
import { staffTokenFromCookies } from "@/lib/api/server";
import { getBranding } from "@/lib/branding";
import { contactEmail, publicOrigin } from "@/lib/landing";

/**
 * The public front page. It used to redirect to `/admin`, which sent every visitor, participant or
 * not, to a sign-in form. It now says what the product is and offers two ways in: the staff sign-in
 * and, for someone who was sent an interview link, a reminder that the link is all they need.
 *
 * A visitor who is already signed in is not redirected: the page offers "Go to the overview" in
 * the header, the hero and the closing block. A cookie is enough to decide that, because the page
 * shows nothing that depends on who they are, and `/admin` checks the session for real.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  const s = stringsFor(locale);
  const h = await headers();
  const origin = publicOrigin({ host: h.get("host"), forwardedProto: h.get("x-forwarded-proto") });
  const { productName } = await getBranding();
  const title = `${productName}: ${s.landing.meta.titleTail}`;
  return {
    metadataBase: new URL(origin),
    title: { absolute: title },
    description: s.landing.meta.description,
    robots: { index: true, follow: true },
    alternates: { canonical: "/" },
    // The card image is a static file of this site (a screenshot of the product): no request to
    // another host, and it carries no text, so a rename of the product does not date it.
    openGraph: {
      type: "website",
      siteName: productName,
      title,
      description: s.landing.meta.description,
      locale: locale === "fi" ? "fi_FI" : "en_GB",
      url: "/",
      images: [{ url: "/landing/og.png", width: 1200, height: 630, alt: s.landing.hero.visualAlt }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: s.landing.meta.description,
      images: ["/landing/og.png"],
    },
  };
}

export default async function HomePage(): Promise<React.JSX.Element> {
  const locale = await requestLocale();
  const s = stringsFor(locale);
  const signedIn = Boolean(await staffTokenFromCookies());
  const { productName, logoUrl } = await getBranding();
  return (
    <Landing
      strings={s.landing}
      appName={productName}
      logoUrl={logoUrl}
      signedIn={signedIn}
      contact={contactEmail()}
    />
  );
}

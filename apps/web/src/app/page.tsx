import type { Metadata } from "next";
import * as React from "react";
import { Landing } from "@/components/landing/Landing";
import { stringsFor } from "@/i18n";
import { requestLocale } from "@/i18n/server";
import { staffTokenFromCookies } from "@/lib/api/server";
import { contactEmail } from "@/lib/landing";

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
  return {
    title: { absolute: `${s.app.name}: ${s.landing.meta.titleTail}` },
    description: s.landing.meta.description,
    robots: { index: true, follow: true },
  };
}

export default async function HomePage(): Promise<React.JSX.Element> {
  const locale = await requestLocale();
  const s = stringsFor(locale);
  const signedIn = Boolean(await staffTokenFromCookies());
  return <Landing strings={s.landing} appName={s.app.name} signedIn={signedIn} contact={contactEmail()} />;
}

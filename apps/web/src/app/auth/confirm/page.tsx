import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import * as React from "react";
import { AuthShell } from "@/components/common/AuthShell";
import { StateView } from "@/components/common/StateView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";
import { CALLBACK_PATH, readConfirmParams } from "@/lib/auth/confirm-link";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getStrings()).kit.authPages.confirmTitle,
    robots: { index: false, follow: false },
    // The token is in this page's address; it must not travel on to anything the page loads.
    referrer: "no-referrer",
  };
}

interface Props {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** The site's own origin: AUTH_URL in a deployment, the request's host otherwise. */
async function siteOrigin(): Promise<string> {
  if (process.env.AUTH_URL) return new URL(process.env.AUTH_URL).origin;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

/**
 * Where the sign-in email lands (lib/auth/confirm-link.ts). Showing it spends nothing; the button
 * submits the token to Auth.js. There is deliberately no link to the callback on this page, so a
 * mail scanner that follows links finds nothing to follow.
 */
export default async function ConfirmSignInPage({ searchParams }: Props = {}): Promise<React.JSX.Element> {
  await requestLocale();
  const p = t.kit.authPages;
  const params = readConfirmParams(searchParams ? await searchParams : {}, await siteOrigin());
  if (!params) {
    return (
      <AuthShell variant="centered">
        <StateView
          illustration="lock"
          title={p.errorTitle}
          body={p.errorBody}
          actions={
            <Button asChild>
              <Link href="/auth/signin">{t.app.signIn}</Link>
            </Button>
          }
        />
      </AuthShell>
    );
  }
  return (
    <AuthShell variant="centered">
      <StateView
        illustration="mail"
        title={p.confirmTitle}
        body={p.confirmBody(params.email)}
        actions={
          <form method="get" action={CALLBACK_PATH}>
            <input type="hidden" name="token" value={params.token} />
            <input type="hidden" name="email" value={params.email} />
            {params.callbackUrl ? (
              <input type="hidden" name="callbackUrl" value={params.callbackUrl} />
            ) : null}
            <Button type="submit" size="lg">
              {p.confirmButton}
            </Button>
          </form>
        }
        detail={p.confirmHelp}
      />
    </AuthShell>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { AuthShell } from "@/components/common/AuthShell";
import { StateView } from "@/components/common/StateView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).kit.authPages.errorTitle };
}

interface Props {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Auth.js reports a relay that refused the message as `EmailSignin`, and a server that could not
 * even build the transport as `Configuration`. Both mean the same thing to the person at the
 * screen and to whoever runs the installation: the mail could not be sent. Saying "the link may
 * have expired" there would send them looking in the wrong place.
 */
export default async function AuthErrorPage({ searchParams }: Props = {}): Promise<React.JSX.Element> {
  await requestLocale();
  const sp = searchParams ? await searchParams : {};
  const code = typeof sp.error === "string" ? sp.error : "";
  const mail = code === "EmailSignin" || code === "Configuration";
  const p = t.kit.authPages;
  return (
    <AuthShell variant="centered">
      <StateView
        illustration="lock"
        title={mail ? p.errorMailTitle : p.errorTitle}
        body={mail ? p.errorMailBody : p.errorBody}
        actions={
          <Button asChild>
            <Link href="/auth/signin">{t.app.signIn}</Link>
          </Button>
        }
      />
    </AuthShell>
  );
}

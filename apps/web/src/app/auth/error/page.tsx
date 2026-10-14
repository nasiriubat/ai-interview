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

export default async function AuthErrorPage(): Promise<React.JSX.Element> {
  await requestLocale();
  const p = t.kit.authPages;
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

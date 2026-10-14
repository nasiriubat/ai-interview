import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { signOutAction } from "@/app/admin/actions";
import { AuthShell } from "@/components/common/AuthShell";
import { StateView } from "@/components/common/StateView";
import { SubmitButton } from "@/components/common/SubmitButton";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).kit.authPages.signOutTitle };
}

/** The confirmation behind "Sign out": one deliberate step, then back to the sign-in page. */
export default async function SignOutPage(): Promise<React.JSX.Element> {
  await requestLocale();
  const p = t.kit.authPages;
  return (
    <AuthShell variant="centered">
      <StateView
        illustration="lock"
        title={p.signOutTitle}
        body={p.signOutBody}
        actions={
          <>
            <form action={signOutAction}>
              <SubmitButton>{p.signOutConfirm}</SubmitButton>
            </form>
            <Button asChild variant="outline">
              <Link href="/admin">{p.signOutStay}</Link>
            </Button>
          </>
        }
      />
    </AuthShell>
  );
}

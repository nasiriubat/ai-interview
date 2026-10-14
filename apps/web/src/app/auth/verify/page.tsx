import type { Metadata } from "next";
import Link from "next/link";
import * as React from "react";
import { AuthShell } from "@/components/common/AuthShell";
import { StateView } from "@/components/common/StateView";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).kit.authPages.linkSentTitle };
}

export default async function VerifyRequestPage(): Promise<React.JSX.Element> {
  await requestLocale();
  const p = t.kit.authPages;
  return (
    <AuthShell variant="centered">
      <StateView
        illustration="mail"
        title={p.linkSentTitle}
        body={p.linkSentBody}
        actions={
          <Button asChild variant="outline">
            <Link href="/auth/signin">{p.tryAgain}</Link>
          </Button>
        }
        detail={p.linkSentHelp}
      />
      <ol className="bg-card shadow-card mx-auto mt-4 grid max-w-sm gap-3 rounded-lg p-5 text-left text-sm">
        {p.linkSentSteps.map((step, i) => (
          <li key={step} className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="bg-accent text-accent-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold"
            >
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
    </AuthShell>
  );
}

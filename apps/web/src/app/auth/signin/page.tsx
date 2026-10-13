import type { Metadata } from "next";
import * as React from "react";
import { signInWithEmail, signInWithGoogle } from "../actions";
import { CenteredShell } from "@/components/common/CenteredShell";
import { SubmitButton } from "@/components/common/SubmitButton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { getStrings } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).app.signIn };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignInPage({ searchParams }: Props): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const callbackUrl = typeof sp.callbackUrl === "string" ? sp.callbackUrl : "/admin";
  const error = typeof sp.error === "string" ? sp.error : undefined;
  // Matches the provider list in auth.config.ts: no credentials, no button. Offering a Google
  // button that fails at the redirect is worse than not offering one.
  const googleEnabled = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  return (
    <CenteredShell className="grid gap-5">
      <div className="grid gap-1.5">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">{t.auth.title}</h1>
        <p className="text-muted-foreground text-sm">
          {googleEnabled ? t.auth.subtitle : t.auth.subtitleEmailOnly}
        </p>
      </div>
      <div className="grid gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{t.auth.error}</AlertDescription>
          </Alert>
        ) : null}
        {googleEnabled ? (
          <>
            <form action={signInWithGoogle}>
              <input type="hidden" name="callbackUrl" value={callbackUrl} />
              <SubmitButton variant="outline" className="w-full">
                {t.auth.google}
              </SubmitButton>
            </form>
            <div className="text-muted-foreground flex items-center gap-3 text-xs">
              <span className="bg-border h-px flex-1" />
              {t.auth.or}
              <span className="bg-border h-px flex-1" />
            </div>
          </>
        ) : null}
        <form action={signInWithEmail} className="grid gap-3">
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <div className="grid gap-1.5">
            <Label htmlFor="email">{t.auth.emailLabel}</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder={t.auth.emailPlaceholder}
            />
          </div>
          <SubmitButton className="w-full">{t.auth.sendLink}</SubmitButton>
        </form>
      </div>
    </CenteredShell>
  );
}

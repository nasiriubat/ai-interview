import { CheckCircle2Icon, ClockIcon } from "lucide-react";
import type { Metadata } from "next";
import * as React from "react";
import { signInWithEmail, signInWithGoogle } from "../actions";
import { AuthHeading, AuthShell } from "@/components/common/AuthShell";
import { SubmitButton } from "@/components/common/SubmitButton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { getStrings, requestLocale } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getStrings()).app.signIn };
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignInPage({ searchParams }: Props): Promise<React.JSX.Element> {
  await requestLocale();
  const sp = await searchParams;
  const callbackUrl = typeof sp.callbackUrl === "string" ? sp.callbackUrl : "/admin";
  const error = typeof sp.error === "string" ? sp.error : undefined;
  const expired = sp.reason === "expired";
  const signedOut = sp.signedOut === "1";
  const p = t.kit.authPages;
  // Matches the provider list in auth.config.ts: no credentials, no button. Offering a Google
  // button that fails at the redirect is worse than not offering one.
  const googleEnabled = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  return (
    <AuthShell>
      <div className="grid gap-6">
        <AuthHeading
          eyebrow={p.signInEyebrow}
          title={t.auth.title}
          body={googleEnabled ? t.auth.subtitle : t.auth.subtitleEmailOnly}
        />
        {expired ? (
          <Alert variant="warning" role="status">
            <ClockIcon />
            <AlertDescription>
              <strong className="block font-medium">{p.expiredTitle}</strong>
              {p.expiredBody}
            </AlertDescription>
          </Alert>
        ) : null}
        {signedOut ? (
          <Alert role="status">
            <CheckCircle2Icon />
            <AlertDescription>
              <strong className="block font-medium">{p.signedOutTitle}</strong>
              {p.signedOutBody}
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{t.auth.error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-4">
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
          <form action={signInWithEmail} className="grid gap-4">
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
                className="h-11"
              />
            </div>
            <SubmitButton className="h-11 w-full">{t.auth.sendLink}</SubmitButton>
          </form>
        </div>
        <p className="text-muted-foreground text-xs lg:hidden">{t.kit.brand.footer}</p>
      </div>
    </AuthShell>
  );
}

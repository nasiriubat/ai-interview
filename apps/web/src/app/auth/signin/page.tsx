import type { Metadata } from "next";
import * as React from "react";
import { signInWithEmail, signInWithGoogle } from "../actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

export const metadata: Metadata = { title: t.app.signIn };

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignInPage({ searchParams }: Props): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const callbackUrl = typeof sp.callbackUrl === "string" ? sp.callbackUrl : "/admin";
  const error = typeof sp.error === "string" ? sp.error : undefined;
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t.auth.title}</CardTitle>
          <CardDescription>{t.auth.subtitle}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{t.auth.error}</AlertDescription>
            </Alert>
          ) : null}
          <form action={signInWithGoogle}>
            <input type="hidden" name="callbackUrl" value={callbackUrl} />
            <Button type="submit" variant="outline" className="w-full">
              {t.auth.google}
            </Button>
          </form>
          <div className="text-muted-foreground flex items-center gap-3 text-xs">
            <span className="bg-border h-px flex-1" />
            {t.auth.or}
            <span className="bg-border h-px flex-1" />
          </div>
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
            <Button type="submit" className="w-full">
              {t.auth.sendLink}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

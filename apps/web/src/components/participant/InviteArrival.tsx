"use client";

import type { Path } from "@aidp/shared";
import { useRouter } from "next/navigation";
import * as React from "react";
import { PathChoice } from "./PathChoice";
import { CenteredShell } from "@/components/common/CenteredShell";
import { LanguageSwitch } from "@/components/common/LanguageSwitch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { participantClient } from "@/lib/api/browser";
import { errorMessage } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";
import type { InviteArrival as InviteInfo } from "@/lib/api/schemas";

type Step = "arrival" | "consent" | "path";

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <CenteredShell aside={<LanguageSwitch />} className="grid gap-6">
      {children}
    </CenteredShell>
  );
}

/**
 * Arrival of an external person invited into a requirements session (contract 18):
 * arrival → consent (opens the session, token in the cookie) → (path) → /p/session.
 */
export function InviteArrival({
  token,
  session,
  api = participantClient,
}: {
  token: string;
  session: InviteInfo["session"];
  api?: ParticipantApi;
}): React.JSX.Element {
  const router = useRouter();
  const s = t.participant.invite;
  const [step, setStep] = React.useState<Step>("arrival");
  const [agreed, setAgreed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const needsPath = session.pathSelection === "technical_or_not";

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e, t.app.unknownError));
    } finally {
      setBusy(false);
    }
  };

  const consent = (): void => {
    void run(async () => {
      const grant = await api.openInvite(token);
      if (grant.resume) {
        router.push("/p/session");
        return;
      }
      await api.consent({ consentVersion: session.consentVersion });
      if (needsPath) {
        setStep("path");
        return;
      }
      router.push("/p/session");
    });
  };

  const choosePath = (path: Path): void => {
    void run(async () => {
      await api.setPath(path);
      router.push("/p/session");
    });
  };

  const errorBox = error ? (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null;

  switch (step) {
    case "arrival":
      return (
        <Shell>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{s.eyebrow}</p>
          <div className="grid gap-2">
            <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
              {s.welcome(session.title)}
            </h1>
            {session.purpose ? <p className="text-muted-foreground">{session.purpose}</p> : null}
          </div>
          <dl className="grid gap-4 text-sm">
            <div>
              <dt className="font-medium">{s.lengthHeading}</dt>
              <dd className="text-muted-foreground">{s.lengthBody}</dd>
            </div>
            <div>
              <dt className="font-medium">{s.storedHeading}</dt>
              <dd className="text-muted-foreground">{s.stored}</dd>
            </div>
          </dl>
          {errorBox}
          <Button
            size="lg"
            className="w-full"
            onClick={() => {
              setStep("consent");
            }}
          >
            {s.start}
          </Button>
          <p className="text-muted-foreground text-center text-xs">
            {t.participant.arrival.noAccount}
            {session.productName ? ` · ${t.participant.arrival.poweredBy(session.productName)}` : ""}
          </p>
        </Shell>
      );

    case "consent":
      return (
        <Shell>
          <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
            {t.participant.consent.title}
          </h1>
          <Card>
            <CardContent className="text-sm leading-relaxed whitespace-pre-wrap">
              {session.consentText}
            </CardContent>
          </Card>
          <div className="flex items-start gap-3">
            <Checkbox
              id="invite-consent"
              checked={agreed}
              onCheckedChange={(v) => {
                setAgreed(v === true);
              }}
            />
            <Label htmlFor="invite-consent" className="leading-snug">
              {s.consentCheckbox}
            </Label>
          </div>
          {errorBox}
          <Button size="lg" onClick={consent} disabled={busy || !agreed} className="w-full">
            {busy ? t.participant.consent.starting : t.participant.consent.start}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setStep("arrival");
            }}
          >
            {t.app.back}
          </Button>
        </Shell>
      );

    case "path":
      return (
        <Shell>
          <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
            {t.participant.path.title}
          </h1>
          <PathChoice disabled={busy} onChoose={choosePath} />
          {errorBox}
        </Shell>
      );
  }
}

"use client";

import type { Path } from "@aidp/shared";
import { CodeIcon, MessageCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { t } from "@/i18n";
import { participantClient } from "@/lib/api/browser";
import { errorMessage, isApiError } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";
import type { PublicCampaign } from "@/lib/api/schemas";

type Step = "arrival" | "email" | "code" | "details" | "consent" | "path";
type Choice = "identified" | "anonymous";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 p-6">
      {children}
    </main>
  );
}

function Heading({ title, body }: { title: string; body?: string }): React.JSX.Element {
  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-semibold text-balance">{title}</h1>
      {body ? <p className="text-muted-foreground">{body}</p> : null}
    </div>
  );
}

/**
 * Arrival → (email + code | open) → details (participation choice, fields) → consent →
 * (path) → /p/session. Resumed sessions skip straight to the interview.
 */
export function ArrivalFlow({
  linkToken,
  campaign,
  invitationToken,
  api = participantClient,
}: {
  linkToken: string;
  campaign: PublicCampaign;
  invitationToken?: string | undefined;
  api?: ParticipantApi;
}): React.JSX.Element {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>("arrival");
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [choice, setChoice] = React.useState<Choice>(
    campaign.participationMode === "anonymous" ? "anonymous" : "identified",
  );
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const needsChoice = campaign.participationMode === "participant_choice";
  const needsDetails = needsChoice || campaign.participantFields.length > 0;
  const needsPath = campaign.pathSelection === "technical_or_not";
  const needsCode = campaign.verification === "email_code" && !invitationToken;

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

  const afterGrant = (resume: boolean): void => {
    if (resume) {
      router.push("/p/session");
      return;
    }
    setStep(needsDetails ? "details" : "consent");
  };

  const start = (): void => {
    if (needsCode) {
      setStep("email");
      return;
    }
    void run(async () => {
      const grant = await api.open(linkToken, invitationToken);
      afterGrant(grant.resume);
    });
  };

  const sendCode = (): void => {
    if (!EMAIL_RE.test(email)) {
      setError(t.participant.verify.invalidEmail);
      return;
    }
    void run(async () => {
      await api.requestCode(linkToken, email);
      setStep("code");
    });
  };

  const confirmCode = (): void => {
    void run(async () => {
      try {
        const grant = await api.confirmCode(linkToken, email, code);
        afterGrant(grant.resume);
      } catch (e) {
        if (isApiError(e) && (e.status === 400 || e.status === 401 || e.status === 403)) {
          throw new Error(
            e.code === "domain_not_allowed"
              ? t.participant.verify.domainNotAllowed
              : t.participant.verify.invalidCode,
          );
        }
        throw e;
      }
    });
  };

  const submitDetails = (): void => {
    const missing = campaign.participantFields.find((f) => f.required && !(fields[f.key] ?? "").trim());
    if (missing) {
      setError(t.participant.details.fieldRequired(missing.label));
      return;
    }
    setError(null);
    setStep("consent");
  };

  const consent = (): void => {
    void run(async () => {
      await api.consent({
        consentVersion: consentVersion(campaign.consentText),
        ...(campaign.participantFields.length > 0 ? { participantFields: fields } : {}),
        ...(needsChoice ? { participationChoice: choice } : {}),
      });
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

  const stored =
    campaign.participationMode === "anonymous"
      ? t.participant.arrival.storedAnonymous
      : campaign.participationMode === "participant_choice"
        ? t.participant.arrival.storedChoice
        : t.participant.arrival.storedIdentified;

  switch (step) {
    case "arrival":
      return (
        <Shell>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t.participant.arrival.eyebrow}
          </p>
          <Heading title={t.participant.arrival.welcome(campaign.name)} body={campaign.purpose} />
          <dl className="grid gap-4 text-sm">
            <div>
              <dt className="font-medium">{t.participant.arrival.lengthHeading}</dt>
              <dd className="text-muted-foreground">
                {t.participant.arrival.minutes(campaign.expectedMinutes)}
              </dd>
            </div>
            <div>
              <dt className="font-medium">{t.participant.arrival.storedHeading}</dt>
              <dd className="text-muted-foreground">{stored}</dd>
            </div>
            <div>
              <dt className="font-medium">{t.participant.arrival.deleteHeading}</dt>
              <dd className="text-muted-foreground">{t.participant.arrival.deletePromise}</dd>
            </div>
          </dl>
          {errorBox}
          <Button size="lg" onClick={start} disabled={busy} className="w-full">
            {busy ? t.app.loading : t.participant.arrival.start}
          </Button>
          <p className="text-muted-foreground text-center text-xs">
            {t.participant.arrival.noAccount}
            {campaign.productName ? ` · ${t.participant.arrival.poweredBy(campaign.productName)}` : ""}
          </p>
        </Shell>
      );

    case "email":
      return (
        <Shell>
          <Heading title={t.participant.verify.title} body={t.participant.verify.body} />
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="email">{t.participant.verify.emailLabel}</Label>
              <Input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                placeholder={t.participant.verify.emailPlaceholder}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
              />
            </div>
            {errorBox}
            <Button type="submit" size="lg" disabled={busy}>
              {busy ? t.participant.verify.sending : t.participant.verify.sendCode}
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
          </form>
        </Shell>
      );

    case "code":
      return (
        <Shell>
          <Heading title={t.participant.verify.codeTitle} body={t.participant.verify.codeBody(email)} />
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              confirmCode();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="code">{t.participant.verify.codeLabel}</Label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                aria-describedby="code-hint"
                className="text-center text-2xl tracking-[0.5em]"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                }}
              />
              <p id="code-hint" className="text-muted-foreground text-xs">
                {t.participant.verify.codeHint}
              </p>
            </div>
            {errorBox}
            <Button type="submit" size="lg" disabled={busy || code.length !== 6}>
              {busy ? t.participant.verify.confirming : t.participant.verify.confirm}
            </Button>
            <div className="flex justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCode("");
                  setStep("email");
                }}
              >
                {t.participant.verify.changeEmail}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={sendCode}>
                {t.participant.verify.resend}
              </Button>
            </div>
          </form>
        </Shell>
      );

    case "details":
      return (
        <Shell>
          <Heading title={t.participant.details.title} body={t.participant.details.body} />
          <form
            className="grid gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              submitDetails();
            }}
          >
            {needsChoice ? (
              <fieldset className="grid gap-3">
                <legend className="mb-2 font-medium">{t.participant.details.choiceTitle}</legend>
                <RadioGroup
                  value={choice}
                  onValueChange={(v) => {
                    setChoice(v === "anonymous" ? "anonymous" : "identified");
                  }}
                >
                  {(
                    [
                      ["identified", t.participant.details.identified, t.participant.details.identifiedHint],
                      ["anonymous", t.participant.details.anonymous, t.participant.details.anonymousHint],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
                    >
                      <RadioGroupItem value={value} className="mt-0.5" aria-describedby={`${value}-hint`} />
                      <span className="grid gap-0.5">
                        <span className="font-medium">{label}</span>
                        <span id={`${value}-hint`} className="text-muted-foreground text-sm">
                          {hint}
                        </span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
            ) : null}
            {campaign.participantFields.map((f) => (
              <div key={f.key} className="grid gap-1.5">
                <Label htmlFor={`field-${f.key}`}>
                  {f.label}
                  {!f.required ? (
                    <span className="text-muted-foreground font-normal"> ({t.app.optional})</span>
                  ) : null}
                </Label>
                <Input
                  id={`field-${f.key}`}
                  required={f.required}
                  value={fields[f.key] ?? ""}
                  onChange={(e) => {
                    setFields((prev) => ({ ...prev, [f.key]: e.target.value }));
                  }}
                />
              </div>
            ))}
            {errorBox}
            <Button type="submit" size="lg">
              {t.app.continue}
            </Button>
          </form>
        </Shell>
      );

    case "consent":
      return (
        <Shell>
          <Heading title={t.participant.consent.title} />
          <Card>
            <CardContent className="text-sm leading-relaxed whitespace-pre-wrap">
              {campaign.consentText}
            </CardContent>
          </Card>
          {errorBox}
          <Button size="lg" onClick={consent} disabled={busy} className="w-full">
            {busy ? t.participant.consent.starting : t.participant.consent.start}
          </Button>
        </Shell>
      );

    case "path":
      return (
        <Shell>
          <Heading title={t.participant.path.title} />
          <div className="grid gap-3">
            {(
              [
                ["technical", t.participant.path.technical, t.participant.path.technicalHint, CodeIcon],
                [
                  "nontechnical",
                  t.participant.path.nontechnical,
                  t.participant.path.nontechnicalHint,
                  MessageCircleIcon,
                ],
              ] as const
            ).map(([value, label, hint, Icon]) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                className="hover:bg-accent focus-visible:ring-ring/50 flex items-start gap-4 rounded-xl border p-4 text-left transition-colors focus-visible:ring-[3px] disabled:opacity-50"
                onClick={() => {
                  choosePath(value);
                }}
              >
                <Icon className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
                <span className="grid gap-1">
                  <span className="text-lg font-semibold">{label}</span>
                  <span className="text-muted-foreground text-sm">{hint}</span>
                </span>
              </button>
            ))}
          </div>
          {errorBox}
        </Shell>
      );
  }
}

/** A stable version tag for the consent text shown, so the API can record what was accepted. */
export function consentVersion(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `v1-${(h >>> 0).toString(16)}`;
}

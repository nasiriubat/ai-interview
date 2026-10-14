"use client";

import { isEmailAddress, isSmtpHost, SMTP_DEFAULT_PORTS, SMTP_PASSWORD_UNCHANGED } from "@aidp/shared";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  MailCheckIcon,
  ServerIcon,
  TriangleAlertIcon,
} from "lucide-react";
import * as React from "react";
import { Field } from "@/components/admin/forms";
import { SecretField } from "@/components/form/controls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { SmtpView } from "@/lib/api/schemas";
import type { EmailTestDraft, SmtpFormBody } from "@/lib/api/staff";

type Security = "starttls" | "ssl" | "none";

/** What the person has typed into the mail server form. The password is write-only. */
export interface SmtpDraft {
  host: string;
  port: string;
  security: Security;
  username: string;
  password: string;
  /** "Remove saved password" was chosen. */
  passwordRemoved: boolean;
  /** "Stop using my own server": the value at this scope is cleared and the inherited one applies. */
  inherit: boolean;
}

export function initialSmtpDraft(view: SmtpView | null | undefined): SmtpDraft {
  const set = view?.set;
  return {
    host: set?.host ?? "",
    port: String(set?.port ?? SMTP_DEFAULT_PORTS.starttls),
    security: set?.security ?? "starttls",
    username: set?.username ?? "",
    password: "",
    passwordRemoved: false,
    inherit: false,
  };
}

export function smtpDraftDirty(draft: SmtpDraft, initial: SmtpDraft): boolean {
  return (
    draft.host !== initial.host ||
    draft.port !== initial.port ||
    draft.security !== initial.security ||
    draft.username !== initial.username ||
    draft.password !== "" ||
    draft.passwordRemoved ||
    draft.inherit
  );
}

export interface SmtpErrors {
  host?: string;
  port?: string;
}

export function smtpDraftErrors(draft: SmtpDraft): SmtpErrors {
  const k = t.admin.settings.email.form.errors;
  const errors: SmtpErrors = {};
  const host = draft.host.trim();
  if (host === "") errors.host = k.host;
  else if (!isSmtpHost(host)) errors.host = k.hostFormat;
  const port = Number(draft.port);
  if (!/^\d{1,5}$/.test(draft.port.trim()) || port < 1 || port > 65535) errors.port = k.port;
  return errors;
}

export function smtpDraftBody(draft: SmtpDraft): SmtpFormBody {
  return {
    host: draft.host.trim(),
    port: Number(draft.port.trim()),
    security: draft.security,
    username: draft.username,
    password: draft.passwordRemoved ? null : draft.password !== "" ? draft.password : SMTP_PASSWORD_UNCHANGED,
  };
}

export function emailAddressError(value: string): string | undefined {
  const v = value.trim();
  if (v === "" || isEmailAddress(v) || /<[^<>\s]+@[^<>\s]+>$/.test(v)) return undefined;
  return t.admin.settings.email.form.errors.email;
}

interface EmailPanelProps {
  scope: string;
  scopeId: string | undefined;
  view: SmtpView | null | undefined;
  draft: SmtpDraft;
  initial: SmtpDraft;
  onDraft: (next: SmtpDraft) => void;
  /** Show field errors: set after a failed save or once a field was left. */
  showErrors: boolean;
  from: string;
  replyTo: string;
  onFrom: (v: string) => void;
  onReplyTo: (v: string) => void;
  /** Tenants cannot choose plain text: the egress policy would refuse it, so it is not offered. */
  allowPlain: boolean;
  /** The sender and reply-to as the viewer would see them in the form, saved or not. */
  disabled?: boolean;
}

/**
 * The mail relay as a form (D-410, D-411): host, port, security, username, password, sender and
 * reply-to, in place of the single connection-string field. It reads and writes the same
 * `email.smtpUrl` secret; the API composes and parses it, so nothing stored changes shape.
 */
export function EmailPanel({
  scope,
  scopeId,
  view,
  draft,
  initial,
  onDraft,
  showErrors,
  from,
  replyTo,
  onFrom,
  onReplyTo,
  allowPlain,
  disabled = false,
}: EmailPanelProps): React.JSX.Element {
  const k = t.admin.settings.email.form;
  const errors = showErrors ? smtpDraftErrors(draft) : {};
  const fromError = showErrors ? emailAddressError(from) : undefined;
  const replyError = showErrors ? emailAddressError(replyTo) : undefined;
  const passwordStored = Boolean(view?.set?.passwordSet) && !draft.passwordRemoved;
  const locked = disabled || draft.inherit;
  const [touchedHost, setTouchedHost] = React.useState(false);
  const hostError =
    errors.host ?? (touchedHost && draft.host !== "" ? smtpDraftErrors(draft).host : undefined);

  const update = (patch: Partial<SmtpDraft>): void => {
    onDraft({ ...draft, ...patch });
  };

  const onSecurity = (next: Security): void => {
    // The port follows the choice while it still holds the previous default; a custom port stays.
    const wasDefault = draft.port.trim() === "" || Number(draft.port) === SMTP_DEFAULT_PORTS[draft.security];
    update({ security: next, ...(wasDefault ? { port: String(SMTP_DEFAULT_PORTS[next]) } : {}) });
  };

  const effective = view?.effective ?? "none";
  const setHere = Boolean(view?.set) && !draft.inherit;
  const sourceKey: "tenant" | "platform" | "env" | "none" = setHere
    ? scope === "platform"
      ? "platform"
      : "tenant"
    : effective === "tenant" && draft.inherit
      ? scope === "platform"
        ? "env"
        : "platform"
      : effective;
  const headline =
    setHere && scope === "platform"
      ? k.source.platformSet
      : sourceKey === "tenant"
        ? k.source.tenantSet
        : sourceKey === "platform"
          ? k.source.platform
          : sourceKey === "env"
            ? k.source.env
            : k.source.none;

  const securityOptions: Security[] = allowPlain ? ["starttls", "ssl", "none"] : ["starttls", "ssl"];

  return (
    <div className="grid max-w-3xl gap-4" data-testid="email-panel">
      <div
        className="bg-card shadow-card grid gap-3 rounded-lg p-4 md:p-5"
        data-testid="email-source"
        data-source={sourceKey}
      >
        <div className="flex flex-wrap items-center gap-2">
          <ServerIcon className="text-muted-foreground size-4" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{k.serverTitle}</h3>
          <Badge
            variant={sourceKey === "none" ? "warning" : sourceKey === "env" ? "info" : "success"}
            data-testid="email-source-badge"
          >
            {k.sourceBadge[sourceKey]}
          </Badge>
        </div>
        <p className="text-muted-foreground text-[13px] leading-snug" role="status">
          {headline}
        </p>
        {sourceKey === "none" ? (
          <Alert variant="warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription>{k.source.none}</AlertDescription>
          </Alert>
        ) : null}
        <fieldset disabled={locked} className="m-0 grid min-w-0 gap-4 border-0 p-0">
          <legend className="sr-only">{k.serverTitle}</legend>
          <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
            <Field id="smtp-host" label={k.host} hint={k.hostHint} error={hostError} required>
              <Input
                id="smtp-host"
                value={draft.host}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                placeholder="smtp.example.com"
                aria-invalid={hostError ? true : undefined}
                aria-describedby={[`smtp-host-hint`, hostError ? "smtp-host-error" : ""]
                  .filter(Boolean)
                  .join(" ")}
                onBlur={() => {
                  setTouchedHost(true);
                }}
                onChange={(e) => {
                  update({ host: e.target.value });
                }}
              />
            </Field>
            <Field id="smtp-port" label={k.port} error={errors.port} required>
              <Input
                id="smtp-port"
                inputMode="numeric"
                autoComplete="off"
                value={draft.port}
                aria-invalid={errors.port ? true : undefined}
                aria-describedby={errors.port ? "smtp-port-error" : undefined}
                onChange={(e) => {
                  update({ port: e.target.value.replace(/[^\d]/g, "").slice(0, 5) });
                }}
              />
            </Field>
          </div>

          <Field id="smtp-security" label={k.security} hint={k.securityHint}>
            <Select
              value={draft.security}
              onValueChange={(v) => {
                onSecurity(v as Security);
              }}
            >
              <SelectTrigger
                id="smtp-security"
                className="w-full sm:max-w-80"
                aria-describedby="smtp-security-hint"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {securityOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {k.securityOptions[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Field id="smtp-username" label={k.username} hint={k.usernameHint} optional>
              <Input
                id="smtp-username"
                value={draft.username}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                aria-describedby="smtp-username-hint"
                onChange={(e) => {
                  update({ username: e.target.value });
                }}
              />
            </Field>
            <div className="grid content-start gap-1.5">
              <SecretField
                id="smtp-password"
                label={k.password}
                value={draft.password}
                isSet={passwordStored}
                hint={
                  draft.passwordRemoved
                    ? k.passwordWillRemove
                    : passwordStored
                      ? k.passwordSetHint
                      : undefined
                }
                onChange={(v) => {
                  update({ password: v, passwordRemoved: false });
                }}
              />
              {view?.set?.passwordSet ? (
                <div>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-[13px]"
                    onClick={() => {
                      update({ passwordRemoved: !draft.passwordRemoved, password: "" });
                    }}
                  >
                    {draft.passwordRemoved ? k.passwordUndo : k.passwordRemove}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </fieldset>
        {view?.set && scope !== "platform" ? (
          <div className="border-t pt-3">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-[13px]"
              onClick={() => {
                update({ inherit: !draft.inherit });
              }}
            >
              {draft.inherit ? k.passwordUndo : k.useInherited}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="bg-card shadow-card grid gap-4 rounded-lg p-4 md:p-5">
        <h3 className="text-sm font-semibold">{k.senderTitle}</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <Field id="email-from" label={k.from} hint={k.fromHint} error={fromError}>
            <Input
              id="email-from"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={from}
              aria-invalid={fromError ? true : undefined}
              aria-describedby={`email-from-hint${fromError ? " email-from-error" : ""}`}
              onChange={(e) => {
                onFrom(e.target.value);
              }}
            />
          </Field>
          <Field id="email-replyto" label={k.replyTo} hint={k.replyToHint} error={replyError} optional>
            <Input
              id="email-replyto"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={replyTo}
              aria-invalid={replyError ? true : undefined}
              aria-describedby={`email-replyto-hint${replyError ? " email-replyto-error" : ""}`}
              onChange={(e) => {
                onReplyTo(e.target.value);
              }}
            />
          </Field>
        </div>
      </div>

      <TestSend
        scope={scope}
        scopeId={scopeId}
        draftBody={smtpDraftDirty(draft, initial) && !draft.inherit ? draft : null}
        from={from}
        replyTo={replyTo}
      />
    </div>
  );
}

function TestSend({
  scope,
  scopeId,
  draftBody,
  from,
  replyTo,
}: {
  scope: string;
  scopeId: string | undefined;
  /** Set when the form differs from what is saved: the test uses it instead of the saved relay. */
  draftBody: SmtpDraft | null;
  from: string;
  replyTo: string;
}): React.JSX.Element {
  const k = t.admin.settings.email;
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<{ ok: true } | { ok: false; message: string } | null>(null);

  const run = (): void => {
    setBusy(true);
    setOutcome(null);
    const errs = draftBody ? smtpDraftErrors(draftBody) : {};
    if (errs.host || errs.port) {
      setOutcome({ ok: false, message: errs.host ?? errs.port ?? "" });
      setBusy(false);
      return;
    }
    const draft: EmailTestDraft = {
      ...(draftBody ? { smtp: smtpDraftBody(draftBody) } : {}),
      ...(from.trim() ? { from: from.trim() } : {}),
      ...(replyTo.trim() ? { replyTo: replyTo.trim() } : {}),
    };
    staffClient.settings
      .emailTest({ scope, ...(scopeId ? { scopeId } : {}) }, draft)
      .then((r) => {
        if (r.ok) setOutcome({ ok: true });
        else {
          const cls = r.errorClass ?? "unknown";
          const map = k.form.testClass as Record<string, string>;
          setOutcome({ ok: false, message: map[cls] ?? r.error ?? k.form.testClass.unknown });
        }
      })
      .catch((e: unknown) => {
        setOutcome({ ok: false, message: e instanceof Error ? e.message : t.app.unknownError });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="bg-card shadow-card grid gap-3 rounded-lg p-4 md:p-5" data-testid="email-test">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground min-w-0 flex-1 text-[13px] leading-snug">{k.form.testIntro}</p>
        <Button
          type="button"
          variant="outline"
          loading={busy}
          onClick={run}
          className="self-start sm:self-auto"
        >
          <MailCheckIcon aria-hidden="true" /> {busy ? k.sending : k.test}
        </Button>
      </div>
      <div aria-live="polite" className="grid gap-0">
        {outcome?.ok ? (
          <Alert variant="success" data-testid="email-test-ok">
            <CheckCircle2Icon aria-hidden="true" />
            <AlertDescription>{k.form.testOk}</AlertDescription>
          </Alert>
        ) : null}
        {outcome && !outcome.ok ? (
          <Alert variant="destructive" data-testid="email-test-error">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>{outcome.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}

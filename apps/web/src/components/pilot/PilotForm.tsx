"use client";

import {
  PILOT_COMPANY_SIZES,
  PILOT_INTERESTS,
  PILOT_LIMITS,
  PILOT_PARTICIPANTS,
  type PilotCompanySize,
  type PilotInterest,
  type PilotParticipants,
} from "@aidp/shared";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { describedBy, Field, TextAreaField, TextField, ValidatedForm } from "@/components/admin/forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { currentLocale, t } from "@/i18n";
import type { FormIssue } from "@/lib/admin/validation";
import { cn } from "@/lib/utils";

/** Where the form's two calls go: the web app's own route, which relays to the API. */
export const PILOT_ENDPOINT = "/api/pilot";

interface Values {
  name: string;
  email: string;
  company: string;
  role: string;
  companySize: PilotCompanySize | "";
  interest: PilotInterest | "";
  participants: PilotParticipants | "";
  message: string;
  consent: boolean;
}

type FieldName = keyof Values;

const EMPTY: Values = {
  name: "",
  email: "",
  company: "",
  role: "",
  companySize: "",
  interest: "",
  participants: "",
  message: "",
  consent: false,
};

/** Order the fields appear in, which is also the order of the error summary. */
const ORDER: FieldName[] = [
  "name",
  "email",
  "company",
  "role",
  "companySize",
  "interest",
  "participants",
  "message",
  "consent",
];

const ONE_LINE = /\p{Cc}/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type Failure = "generic" | "tooFast" | "stale" | "rateLimited";

/**
 * The same rules as `PilotRequestSchema` in `@aidp/shared`, worded for the person in their
 * language. The API checks the contract again; this only says what to fix before sending.
 */
export function validatePilot(v: Values): Partial<Record<FieldName, string>> {
  const e = t.pilot.errors;
  const out: Partial<Record<FieldName, string>> = {};
  const line = (name: "name" | "company" | "role", max: number): void => {
    const value = v[name].trim();
    if (!value) out[name] = e.required;
    else if (value.length > max) out[name] = e.tooLong(max);
    else if (ONE_LINE.test(value)) out[name] = e.singleLine;
  };
  line("name", PILOT_LIMITS.name);
  const email = v.email.trim();
  if (!email) out.email = e.required;
  else if (email.length > PILOT_LIMITS.email || !EMAIL.test(email)) out.email = e.email;
  line("company", PILOT_LIMITS.company);
  line("role", PILOT_LIMITS.role);
  if (!v.companySize) out.companySize = e.required;
  if (!v.interest) out.interest = e.required;
  if (v.message.trim().length > PILOT_LIMITS.message) out.message = e.tooLong(PILOT_LIMITS.message);
  if (!v.consent) out.consent = e.consent;
  return out;
}

/** A native select in the look of the kit's inputs: keyboard and phone pickers come for free. */
function NativeSelect({
  id,
  label,
  value,
  onChange,
  onBlur,
  options,
  placeholder,
  error,
  hint,
  required,
  optional,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  options: readonly { value: string; label: string }[];
  placeholder: string;
  error?: string | undefined;
  hint?: string | undefined;
  required?: boolean;
  optional?: boolean;
}): React.JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} optional={optional}>
      <div className="relative">
        <select
          id={id}
          name={id}
          value={value}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          onBlur={onBlur}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className={cn(
            "bg-card text-foreground shadow-control h-9 w-full min-w-0 appearance-none rounded-md border-0 py-1 pr-9 pl-3 text-base transition-[color,box-shadow] md:text-sm",
            "hover:shadow-[0_0_0_1px_var(--input-hover)] focus-visible:shadow-[0_0_0_1px_var(--primary)]",
            "aria-invalid:shadow-[0_0_0_1px_var(--destructive)]",
            value === "" && "text-muted-foreground",
          )}
        >
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value} className="text-foreground">
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2"
        />
      </div>
    </Field>
  );
}

/**
 * The "Request a pilot" form (`/pilot`).
 *
 * Errors show when a field is left and on submit, with a summary that links to each field and
 * focus moved to the first one (the kit's `ValidatedForm`). On success the form is replaced by a
 * confirmation that takes focus, so a screen reader hears it. A failure keeps everything typed and
 * says what to do; it never offers an address to write to instead, because that would publish it.
 *
 * Two fields are not the person's: a honeypot that only a script fills, and the ticket the API
 * signed when the page opened, which tells it how long the form was open.
 */
export function PilotForm(): React.JSX.Element {
  const s = t.pilot;
  const f = s.fields;
  const [values, setValues] = React.useState<Values>(EMPTY);
  const [touched, setTouched] = React.useState<ReadonlySet<FieldName>>(new Set());
  const [attempt, setAttempt] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [website, setWebsite] = React.useState("");
  const ticket = React.useRef<string | undefined>(undefined);
  const doneRef = React.useRef<HTMLHeadingElement>(null);

  const fetchTicket = React.useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(PILOT_ENDPOINT, { method: "GET", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { ticket?: unknown };
      if (typeof body.ticket === "string") ticket.current = body.ticket;
    } catch {
      // Without a ticket the API answers "send again", and a new one is asked for then.
    }
  }, []);

  React.useEffect(() => {
    void fetchTicket();
  }, [fetchTicket]);

  React.useEffect(() => {
    if (sentTo) doneRef.current?.focus();
  }, [sentTo]);

  const errors = validatePilot(values);
  const shown = (name: FieldName): string | undefined =>
    attempt > 0 || touched.has(name) ? errors[name] : undefined;
  const id = (name: FieldName): string => `pilot-${name}`;
  const label: Record<FieldName, string> = {
    name: f.name,
    email: f.email,
    company: f.company,
    role: f.role,
    companySize: f.companySize,
    interest: f.interest,
    participants: f.participants,
    message: f.message,
    consent: s.consent,
  };
  const issues: FormIssue[] =
    attempt === 0
      ? []
      : ORDER.filter((n) => errors[n]).map((n) => ({ id: id(n), label: label[n], message: errors[n] ?? "" }));

  const set = <K extends FieldName>(name: K, value: Values[K]): void => {
    setValues((v) => ({ ...v, [name]: value }));
    setFailure(null);
  };
  const leave = (name: FieldName) => (): void => {
    setTouched((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
  };

  const submit = (): void => {
    setAttempt((n) => n + 1);
    if (Object.keys(errors).length > 0 || sending) return;
    setSending(true);
    setFailure(null);
    const body = {
      name: values.name.trim(),
      email: values.email.trim(),
      company: values.company.trim(),
      role: values.role.trim(),
      companySize: values.companySize,
      interest: values.interest,
      ...(values.participants ? { participants: values.participants } : {}),
      ...(values.message.trim() ? { message: values.message.trim() } : {}),
      consent: true,
      locale: currentLocale(),
      website,
      ...(ticket.current ? { ticket: ticket.current } : {}),
    };
    void (async () => {
      try {
        const res = await fetch(PILOT_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          setSentTo(body.email);
          return;
        }
        let reason: unknown;
        try {
          reason = ((await res.json()) as { error?: { details?: { reason?: unknown } } }).error?.details
            ?.reason;
        } catch {
          reason = undefined;
        }
        if (res.status === 429) setFailure("rateLimited");
        else if (reason === "too_fast") setFailure("tooFast");
        else if (reason === "stale") setFailure("stale");
        else setFailure("generic");
        // A refused ticket is spent either way; the next attempt needs a fresh one.
        if (reason === "too_fast" || reason === "stale") void fetchTicket();
      } catch {
        setFailure("generic");
      } finally {
        setSending(false);
      }
    })();
  };

  if (sentTo) {
    return (
      <div role="status" className="grid justify-items-start gap-4 py-2">
        <span className="bg-success-soft text-success-soft-foreground grid size-11 place-items-center rounded-full">
          <CheckIcon className="size-5" aria-hidden="true" strokeWidth={2.5} />
        </span>
        <h2 ref={doneRef} tabIndex={-1} className="text-foreground text-xl font-semibold tracking-tight">
          {s.success.title}
        </h2>
        <p className="text-body text-[15px] leading-relaxed">{s.success.body(sentTo)}</p>
        <Button asChild variant="outline">
          <Link href="/">{s.success.home}</Link>
        </Button>
      </div>
    );
  }

  return (
    <ValidatedForm onSubmit={submit} issues={issues} attempt={attempt} className="grid gap-5">
      <p className="text-muted-foreground text-[13px]">{s.required}</p>
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          id={id("name")}
          label={f.name}
          value={values.name}
          onChange={(v) => {
            set("name", v);
          }}
          onBlur={leave("name")}
          error={shown("name")}
          required
          autoComplete="name"
          maxLength={PILOT_LIMITS.name}
        />
        <TextField
          id={id("email")}
          label={f.email}
          type="email"
          value={values.email}
          onChange={(v) => {
            set("email", v);
          }}
          onBlur={leave("email")}
          error={shown("email")}
          hint={f.emailHint}
          required
          autoComplete="email"
          maxLength={PILOT_LIMITS.email}
        />
        <TextField
          id={id("company")}
          label={f.company}
          value={values.company}
          onChange={(v) => {
            set("company", v);
          }}
          onBlur={leave("company")}
          error={shown("company")}
          required
          autoComplete="organization"
          maxLength={PILOT_LIMITS.company}
        />
        <TextField
          id={id("role")}
          label={f.role}
          value={values.role}
          onChange={(v) => {
            set("role", v);
          }}
          onBlur={leave("role")}
          error={shown("role")}
          required
          autoComplete="organization-title"
          maxLength={PILOT_LIMITS.role}
        />
        <NativeSelect
          id={id("companySize")}
          label={f.companySize}
          value={values.companySize}
          onChange={(v) => {
            set("companySize", v as Values["companySize"]);
          }}
          onBlur={leave("companySize")}
          error={shown("companySize")}
          placeholder={f.choose}
          required
          options={PILOT_COMPANY_SIZES.map((size) => ({
            value: size,
            label: `${size.replace("-", "–")} ${f.companySizeUnit}`,
          }))}
        />
        <NativeSelect
          id={id("participants")}
          label={f.participants}
          value={values.participants}
          onChange={(v) => {
            set("participants", v as Values["participants"]);
          }}
          onBlur={leave("participants")}
          placeholder={f.choose}
          optional
          options={PILOT_PARTICIPANTS.map((p) => ({ value: p, label: s.participants[p] }))}
        />
      </div>
      <NativeSelect
        id={id("interest")}
        label={f.interest}
        value={values.interest}
        onChange={(v) => {
          set("interest", v as Values["interest"]);
        }}
        onBlur={leave("interest")}
        error={shown("interest")}
        placeholder={f.choose}
        required
        options={PILOT_INTERESTS.map((i) => ({ value: i, label: s.interest[i] }))}
      />
      <TextAreaField
        id={id("message")}
        label={f.message}
        value={values.message}
        onChange={(v) => {
          set("message", v);
        }}
        onBlur={leave("message")}
        error={shown("message")}
        hint={f.messageHint(Math.max(0, PILOT_LIMITS.message - values.message.length))}
        rows={5}
        optional
        maxLength={PILOT_LIMITS.message}
      />

      {/* Honeypot: off-screen, out of the tab order and hidden from assistive technology. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -left-[10000px] h-px w-px overflow-hidden"
      >
        <label htmlFor="pilot-website">{s.honeypot}</label>
        <input
          id="pilot-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => {
            setWebsite(e.target.value);
          }}
        />
      </div>

      <div className="grid gap-1.5">
        <div className="flex items-start gap-3">
          <Checkbox
            id={id("consent")}
            checked={values.consent}
            onCheckedChange={(c) => {
              set("consent", c === true);
            }}
            onBlur={leave("consent")}
            aria-required="true"
            aria-invalid={shown("consent") ? true : undefined}
            aria-describedby={[`${id("consent")}-hint`, shown("consent") ? `${id("consent")}-error` : ""]
              .filter(Boolean)
              .join(" ")}
            className="mt-0.5"
          />
          <div className="grid gap-1">
            <label htmlFor={id("consent")} className="text-foreground text-sm leading-5 font-medium">
              {s.consent}
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            </label>
            <p id={`${id("consent")}-hint`} className="text-muted-foreground text-[13px] leading-snug">
              {s.privacy}
            </p>
          </div>
        </div>
        {shown("consent") ? (
          <p
            id={`${id("consent")}-error`}
            className="text-destructive flex items-start gap-1.5 text-[13px] leading-snug"
          >
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {shown("consent")}
          </p>
        ) : null}
      </div>

      {failure ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{s.failed.title}</AlertTitle>
          <AlertDescription>{s.failed[failure]}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Button type="submit" size="lg" disabled={sending} aria-disabled={sending} className="sm:w-auto">
          {sending ? s.sending : s.submit}
          {sending ? null : <ArrowRightIcon aria-hidden="true" />}
        </Button>
        <p role="status" className="text-destructive text-sm">
          {attempt > 0 && issues.length > 0 ? s.errors.summary(issues.length) : ""}
        </p>
      </div>
    </ValidatedForm>
  );
}

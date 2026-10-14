"use client";

import { AlertTriangleIcon, CircleAlertIcon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Combobox, type ComboboxLabels, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import type { FormIssue } from "@/lib/admin/validation";
import { cn } from "@/lib/utils";

export type FieldErrors = Record<string, string>;

/**
 * Inside a `ValidatedForm` the summary, the focus move and the status line announce the problems,
 * so each field's own error is described to the control (aria-describedby) but is not also a live
 * region: twelve errors at once would otherwise be twelve interruptions.
 */
const QuietFieldErrors = React.createContext(false);

/**
 * A labeled field with an optional hint and error, wired with aria-describedby. `required`
 * paints the red asterisk of contract 19; it is `aria-hidden` because the real semantics
 * live on the native `required` of the control itself.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  optional,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  /** Says "optional" next to the label; for forms where most fields are required. */
  optional?: boolean | undefined;
  children: React.ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  const quiet = React.useContext(QuietFieldErrors);
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id} className="leading-5">
        {label}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
        {optional && !required ? (
          <span className="text-muted-foreground text-[13px] font-normal">({t.kit.form.optional})</span>
        ) : null}
      </Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-[13px] leading-snug">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          className="text-destructive flex items-start gap-1.5 text-[13px] leading-snug"
          role={quiet ? undefined : "alert"}
        >
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function describedBy(id: string, hint?: string, error?: string): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  type = "text",
  required,
  placeholder,
  disabled,
  readOnly,
  onBlur,
  autoComplete,
  maxLength,
  optional,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
  type?: string;
  required?: boolean;
  optional?: boolean;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  onBlur?: () => void;
  autoComplete?: string;
  maxLength?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={required}
      optional={optional}
      className={className}
    >
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        onBlur={onBlur}
        autoComplete={autoComplete}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </Field>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  min,
  max,
  step,
  required,
  disabled,
  onBlur,
}: {
  id: string;
  label: string;
  value: number | "";
  onChange: (v: number | "") => void;
  hint?: string | undefined;
  error?: string | undefined;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  onBlur?: () => void;
}): React.JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        value={value}
        min={min}
        max={max}
        step={step}
        required={required}
        disabled={disabled}
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(e) => {
          onChange(e.target.value === "" ? "" : Number(e.target.value));
        }}
      />
    </Field>
  );
}

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  rows = 3,
  required,
  disabled,
  readOnly,
  onBlur,
  maxLength,
  optional,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
  rows?: number;
  required?: boolean | undefined;
  optional?: boolean | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  onBlur?: () => void;
  maxLength?: number;
}): React.JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} optional={optional}>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        onBlur={onBlur}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </Field>
  );
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  onChange,
  options,
  hint,
  error,
  placeholder,
  required,
  disabled,
  className,
}: {
  id: string;
  label: string;
  value: T | "";
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  hint?: string | undefined;
  error?: string | undefined;
  placeholder?: string;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <Select
        value={value}
        {...(disabled === undefined ? {} : { disabled })}
        {...(required === undefined ? {} : { required })}
        onValueChange={(v) => {
          onChange(v as T);
        }}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function SwitchField({
  id,
  label,
  checked,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string | undefined;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5"
      />
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint ? (
          <p id={`${id}-hint`} className="text-muted-foreground text-xs">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A labeled searchable dropdown: the select2 of this codebase, wired like the other fields. */
export function ComboboxField({
  id,
  label,
  value,
  onChange,
  options,
  labels,
  hint,
  error,
  required,
  allowCustom,
  loading,
  disabled,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly ComboboxOption[];
  labels: ComboboxLabels;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  allowCustom?: boolean | undefined;
  loading?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <Combobox
        id={id}
        value={value}
        onChange={onChange}
        options={options}
        labels={labels}
        allowCustom={allowCustom}
        loading={loading}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
      />
    </Field>
  );
}

export function FormSection({
  id,
  title,
  errorCount = 0,
  children,
}: {
  /** A stable key (the title is localized and changes); the section's anchor is `section-<id>`. */
  id?: string | undefined;
  title: string;
  /** Problems found in this section on the last submit; shown in the heading. */
  errorCount?: number | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const key = id ?? title;
  return (
    <section
      id={`section-${key}`}
      tabIndex={-1}
      className="grid gap-4 bg-card shadow-card rounded-lg p-4 md:p-5"
      aria-labelledby={`section-${key}-title`}
    >
      <h2 id={`section-${key}-title`} className="flex flex-wrap items-center gap-2 text-base font-semibold">
        {title}
        {errorCount > 0 ? (
          <span className="bg-destructive-soft text-destructive-soft-foreground rounded-full px-2 py-0.5 text-xs font-medium">
            {t.admin.form.sectionProblems(errorCount)}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

/**
 * Everything wrong with a form, in one list that is read before the fields. Each entry is a link to
 * its field: activating it moves focus there (the hash alone would only scroll).
 */
export function ErrorSummary({
  issues,
  className,
}: {
  issues: readonly FormIssue[];
  className?: string | undefined;
}): React.JSX.Element | null {
  const headingId = React.useId();
  if (issues.length === 0) return null;
  return (
    <Alert
      variant="destructive"
      // The focus move and the status line announce it; this stays a plain landmark of the page.
      role="status"
      aria-labelledby={headingId}
      className={className}
    >
      <AlertTriangleIcon aria-hidden="true" />
      <AlertTitle id={headingId} className="line-clamp-none">
        {t.admin.form.summaryTitle(issues.length)}
      </AlertTitle>
      <AlertDescription>
        <ul className="grid gap-1">
          {issues.map((issue) => (
            <li key={`${issue.id}:${issue.label}`}>
              <a
                href={`#${issue.id}`}
                className="underline underline-offset-2"
                onClick={(e) => {
                  e.preventDefault();
                  const el = document.getElementById(issue.id);
                  el?.focus();
                  el?.scrollIntoView({ block: "center" });
                }}
              >
                {issue.label}
              </a>
              : {issue.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Under the submit button: says why a click did nothing ("Fix 3 problems to save"). A polite
 * status, so it is read once when it appears and not again on every keystroke.
 */
export function SubmitStatus({ count }: { count: number }): React.JSX.Element {
  return (
    <p role="status" className="text-destructive text-sm">
      {count > 0 ? t.admin.form.problems(count) : ""}
    </p>
  );
}

/**
 * A form that validates on submit. A failed attempt (`attempt` goes up) puts focus on the first
 * field marked invalid, in document order, after the errors have rendered; with the summary above
 * and the field's own description, a keyboard or screen reader user lands on the first thing to fix
 * and can reach the rest from the list. `noValidate`, because the browser's own bubbles are
 * neither localized nor reachable by assistive technology the way these are.
 */
export function ValidatedForm({
  onSubmit,
  issues,
  attempt,
  className,
  children,
}: {
  onSubmit: () => void;
  issues: readonly FormIssue[];
  /** Increment on every failed submit. */
  attempt: number;
  className?: string | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = React.useRef<HTMLFormElement>(null);
  React.useEffect(() => {
    if (attempt === 0) return;
    const first = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"],[data-invalid="true"]');
    first?.focus();
    first?.scrollIntoView({ block: "center" });
  }, [attempt]);
  return (
    <QuietFieldErrors.Provider value>
      <form
        ref={ref}
        noValidate
        className={className}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <ErrorSummary issues={issues} />
        {children}
      </form>
    </QuietFieldErrors.Provider>
  );
}

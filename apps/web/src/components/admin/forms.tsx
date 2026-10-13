"use client";

import * as React from "react";
import { Combobox, type ComboboxLabels, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type FieldErrors = Record<string, string>;

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
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  children: React.ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-destructive text-xs" role="alert">
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
  type?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required}>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        disabled={disabled}
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
  rows?: number;
  required?: boolean | undefined;
}): React.JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required}>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        required={required}
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
}): React.JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required}>
      <Select
        value={value}
        {...(required === undefined ? {} : { required })}
        onValueChange={(v) => {
          onChange(v as T);
        }}
      >
        <SelectTrigger id={id} className="w-full" aria-describedby={describedBy(id, hint, error)}>
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
        aria-describedby={describedBy(id, hint, error)}
      />
    </Field>
  );
}

export function FormSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className="grid gap-4 bg-card shadow-card rounded-lg p-4 md:p-5"
      aria-labelledby={`section-${title}`}
    >
      <h2 id={`section-${title}`} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

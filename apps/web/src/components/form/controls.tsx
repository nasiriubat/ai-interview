"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import * as React from "react";
import { describedBy, Field } from "@/components/admin/forms";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/*
 * The controls the base form kit (`@/components/admin/forms`) did not have (D-342). They follow the
 * same contract as `TextField` and friends: a `Field` around the control, `aria-describedby` to the
 * hint and the error, `aria-invalid` when there is an error, and `id` as the DOM id the error
 * summary focuses. Controlled: the value is the caller's.
 */

interface FieldBase {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Shown as text with no control: an owner-set value the person may see but not change. */
  readOnly?: boolean | undefined;
  className?: string | undefined;
  /** Called when focus leaves the control: where `useForm` starts showing that field's error. */
  onBlur?: (() => void) | undefined;
}

/**
 * A credential: masked, with a button to reveal what was typed. A value that is already saved is
 * never sent to the browser, so `isSet` only says that one exists; typing replaces it, and an empty
 * field means "leave it as it is".
 */
export function SecretField({
  id,
  label,
  hint,
  error,
  required,
  disabled,
  className,
  onBlur,
  value,
  onChange,
  isSet = false,
  placeholder,
}: FieldBase & {
  value: string;
  onChange: (v: string) => void;
  isSet?: boolean;
  placeholder?: string;
}): React.JSX.Element {
  const [shown, setShown] = React.useState(false);
  const k = t.kit.form;
  const help = hint ?? (isSet ? k.secretSet : undefined);
  return (
    <Field id={id} label={label} hint={help} error={error} required={required} className={className}>
      <div className="relative">
        <Input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          placeholder={placeholder ?? (isSet ? "••••••••" : k.secretEmpty)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, help, error)}
          className="pr-10 font-mono"
          onBlur={onBlur}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
        <button
          type="button"
          aria-label={shown ? k.hide : k.show}
          aria-pressed={shown}
          disabled={disabled}
          onClick={() => {
            setShown((v) => !v);
          }}
          className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-md disabled:opacity-50"
        >
          {shown ? (
            <EyeOffIcon className="size-4" aria-hidden="true" />
          ) : (
            <EyeIcon className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </Field>
  );
}

/** A number with its unit fixed to the right inside the box ("30 days", "5 MB", "0.5 USD"). */
export function UnitField({
  id,
  label,
  hint,
  error,
  required,
  disabled,
  readOnly,
  className,
  onBlur,
  value,
  onChange,
  unit,
  min,
  max,
  step,
}: FieldBase & {
  value: number | "";
  onChange: (v: number | "") => void;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
}): React.JSX.Element {
  const unitId = `${id}-unit`;
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={[describedBy(id, hint, error), unitId].filter(Boolean).join(" ")}
          className="pr-16 tabular-nums"
          onBlur={onBlur}
          onChange={(e) => {
            onChange(e.target.value === "" ? "" : Number(e.target.value));
          }}
        />
        <span
          id={unitId}
          className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm"
        >
          {unit}
        </span>
      </div>
    </Field>
  );
}

/** A calendar date, as `YYYY-MM-DD` (what the API takes), with optional bounds. */
export function DateField({
  id,
  label,
  hint,
  error,
  required,
  disabled,
  readOnly,
  className,
  onBlur,
  value,
  onChange,
  min,
  max,
}: FieldBase & {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
}): React.JSX.Element {
  return (
    <Field id={id} label={label} hint={hint} error={error} required={required} className={className}>
      <Input
        id={id}
        type="date"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className="w-full sm:w-48"
        onBlur={onBlur}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </Field>
  );
}

/** One yes/no, with its label and hint to the right of the box. */
export function CheckboxField({
  id,
  label,
  hint,
  error,
  disabled,
  className,
  checked,
  onChange,
}: Omit<FieldBase, "required" | "readOnly" | "onBlur"> & {
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className="mt-px"
        onCheckedChange={(v) => {
          onChange(v === true);
        }}
      />
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="leading-5">
          {label}
        </Label>
        {hint ? (
          <p id={`${id}-hint`} className="text-muted-foreground text-[13px]">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={`${id}-error`} className="text-destructive text-[13px]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  hint?: string | undefined;
  disabled?: boolean | undefined;
}

/** One choice of a few, all visible: each option can carry a line that says what it means. */
export function RadioField<T extends string>({
  id,
  label,
  hint,
  error,
  required,
  disabled,
  className,
  value,
  onChange,
  options,
  orientation = "vertical",
}: Omit<FieldBase, "readOnly" | "onBlur"> & {
  value: T | "";
  onChange: (v: T) => void;
  options: readonly RadioOption<T>[];
  orientation?: "vertical" | "horizontal";
}): React.JSX.Element {
  const legendId = `${id}-legend`;
  return (
    <div className={cn("grid gap-2", className)} role="group" aria-labelledby={legendId}>
      <p id={legendId} className="flex items-center gap-1 text-sm leading-none font-medium">
        {label}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </p>
      <RadioGroup
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        orientation={orientation}
        className={cn(orientation === "horizontal" ? "flex flex-wrap gap-x-6 gap-y-2" : "gap-2.5")}
        onValueChange={(v) => {
          onChange(v as T);
        }}
      >
        {options.map((o) => {
          const optionId = `${id}-${o.value}`;
          return (
            <div key={o.value} className="flex items-start gap-3">
              <RadioGroupItem
                id={optionId}
                value={o.value}
                disabled={o.disabled}
                aria-describedby={o.hint ? `${optionId}-hint` : undefined}
                className="mt-px"
              />
              <div className="grid gap-0.5">
                <Label htmlFor={optionId} className="leading-5">
                  {o.label}
                </Label>
                {o.hint ? (
                  <p id={`${optionId}-hint`} className="text-muted-foreground text-[13px]">
                    {o.hint}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </RadioGroup>
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-[13px]">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-destructive text-[13px]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A value shown the way a field would show it, for what a person may read and not change. */
export function ReadOnlyField({
  id,
  label,
  value,
  hint,
  className,
}: {
  id: string;
  label: string;
  value: React.ReactNode;
  hint?: string | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <p id={`${id}-label`} className="text-sm leading-none font-medium">
        {label}
      </p>
      <div
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="bg-muted/60 text-foreground flex min-h-9 items-center rounded-md px-3 py-1.5 text-sm break-words"
      >
        {value}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-[13px]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

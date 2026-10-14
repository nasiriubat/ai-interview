"use client";

import { CheckIcon, CircleDotIcon, RotateCcwIcon } from "lucide-react";
import * as React from "react";
import { FormSection, SubmitStatus, ValidatedForm } from "@/components/admin/forms";
import type { FormApi } from "@/components/form/useForm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * A form with the kit's behaviour (D-342): validation summary and focus on the first problem, a
 * server error shown inline, and a floating save bar pinned to the bottom of the viewport that
 * says whether there is anything to save. Leaving with unsaved edits asks first (`useForm`
 * registers with the dirty guard).
 *
 * `children` are `FormSection`s and fields; `bar={false}` for a form whose submit is elsewhere.
 */
export function Form<T extends Record<string, unknown>>({
  form,
  children,
  className,
  saveLabel,
  bar = true,
  readOnly = false,
}: {
  form: FormApi<T>;
  children: React.ReactNode;
  className?: string | undefined;
  saveLabel?: string | undefined;
  bar?: boolean;
  /** The person may read but not save: the bar is not drawn. */
  readOnly?: boolean;
}): React.JSX.Element {
  return (
    <ValidatedForm
      onSubmit={form.submit}
      issues={form.issues}
      attempt={form.attempt}
      className={cn("grid gap-5", className)}
    >
      {form.serverError ? (
        <Alert variant="destructive">
          <AlertDescription>{form.serverError}</AlertDescription>
        </Alert>
      ) : null}
      {children}
      {bar && !readOnly ? <SaveBar form={form} saveLabel={saveLabel} /> : null}
    </ValidatedForm>
  );
}

export function SaveBar<T extends Record<string, unknown>>({
  form,
  saveLabel,
}: {
  form: FormApi<T>;
  saveLabel?: string | undefined;
}): React.JSX.Element {
  return (
    <SaveBarView
      dirty={form.dirty}
      submitting={form.submitting}
      problems={form.issues.length}
      onDiscard={form.reset}
      saveLabel={saveLabel}
    />
  );
}

/**
 * The floating save bar by itself, for forms that keep their own state (the settings categories):
 * says whether there is anything to save, and offers Discard and Save. Must sit inside a `<form>`.
 */
export function SaveBarView({
  dirty,
  submitting,
  problems = 0,
  onDiscard,
  saveLabel,
  extra,
  alwaysEnabled = false,
}: {
  dirty: boolean;
  /** Save is offered even with no edit (a settings category re-sends what is set). */
  alwaysEnabled?: boolean;
  submitting: boolean;
  problems?: number;
  onDiscard: () => void;
  saveLabel?: string | undefined;
  /** More actions on the left of Discard (a "send test email"). */
  extra?: React.ReactNode;
}): React.JSX.Element {
  const k = t.kit.form;
  return (
    <div
      data-testid="save-bar"
      className="bg-card shadow-raised sticky bottom-3 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-4 py-3"
    >
      <p role="status" className="text-muted-foreground flex min-w-0 flex-1 items-center gap-2 text-sm">
        {dirty ? (
          <>
            <CircleDotIcon className="text-warning size-4 shrink-0" aria-hidden="true" />
            <span className="text-foreground truncate">{k.unsaved}</span>
          </>
        ) : (
          <>
            <CheckIcon className="text-success size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{k.saved}</span>
          </>
        )}
      </p>
      {problems > 0 ? <SubmitStatus count={problems} /> : null}
      {extra}
      <Button type="button" variant="ghost" disabled={!dirty || submitting} onClick={onDiscard}>
        <RotateCcwIcon aria-hidden="true" />
        {k.discard}
      </Button>
      <Button type="submit" loading={submitting} disabled={!dirty && !alwaysEnabled}>
        {saveLabel ?? k.save}
      </Button>
    </div>
  );
}

export { FormSection };

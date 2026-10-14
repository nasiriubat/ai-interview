"use client";

import * as React from "react";
import type { z } from "zod";
import { useDirty } from "@/components/common/DirtyGuard";
import { notify } from "@/components/common/notify";
import { t } from "@/i18n";
import { issueMessage, type FormIssue } from "@/lib/admin/validation";
import { isApiError } from "@/lib/api/errors";

/** What a field component takes to be driven by the form: spread it, `<TextField {...form.field("name")} />`. */
export interface FieldBinding<V> {
  id: string;
  value: V;
  onChange: (v: V) => void;
  onBlur: () => void;
  error: string | undefined;
}

export interface FormApi<T extends Record<string, unknown>> {
  id: string;
  values: T;
  set: <K extends keyof T>(name: K, value: T[K]) => void;
  /** The binding for one field; its error shows after the field was left or a submit was tried. */
  field: <K extends keyof T & string>(name: K) => FieldBinding<T[K]>;
  /** Every problem, for the summary; empty until a submit was attempted. */
  issues: FormIssue[];
  attempt: number;
  dirty: boolean;
  submitting: boolean;
  /** An error the server answered with that is not about one field. Cleared on the next edit. */
  serverError: string | null;
  submit: () => void;
  reset: () => void;
  /** Marks the current values as saved (after a save made elsewhere). */
  markSaved: () => void;
}

/** Field values equal by content: forms hold strings, numbers, booleans and small arrays. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface UseFormOptions<T extends Record<string, unknown>> {
  /** Names the form to the unsaved-changes guard; unique per page. */
  id: string;
  initial: T;
  /** The rules. Failed rules show on blur and on submit, worded by `issueMessage`. */
  schema: z.ZodType;
  /** Human names of the fields, for the error summary ("Name: this field is required"). */
  labels: Record<string, string>;
  /** Saves. Resolve to confirm; throw (an `ApiError` is read for field errors) to report failure. */
  onSubmit: (values: T) => Promise<void>;
  /** Toast text on success. */
  savedText?: string;
}

/**
 * The state of one form (D-342): values, validation that speaks on blur and on submit, a dirty
 * flag wired to the leave guard, and a submit that runs once at a time and reports in a toast.
 * The server's own validation errors (`validation`, with a path) are put on their fields, so a rule
 * the browser cannot know is shown where the person can fix it.
 */
export function useForm<T extends Record<string, unknown>>(options: UseFormOptions<T>): FormApi<T> {
  const { id, schema, labels, onSubmit, savedText } = options;
  const [values, setValues] = React.useState<T>(options.initial);
  const [saved, setSaved] = React.useState<T>(options.initial);
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [fromServer, setFromServer] = React.useState<Record<string, string>>({});

  const dirty = !same(values, saved);
  useDirty(id, dirty);

  const found = React.useMemo(() => {
    const out: Record<string, string> = {};
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && out[key] === undefined) out[key] = issueMessage(issue);
      }
    }
    return out;
  }, [schema, values]);

  const errorOf = (name: string): string | undefined => {
    const shown = attempt > 0 || touched.has(name);
    return fromServer[name] ?? (shown ? found[name] : undefined);
  };

  const set = React.useCallback(<K extends keyof T>(name: K, value: T[K]): void => {
    setValues((v) => ({ ...v, [name]: value }));
    setServerError(null);
    setFromServer((s) => {
      if (!((name as string) in s)) return s;
      return Object.fromEntries(Object.entries(s).filter(([key]) => key !== (name as string)));
    });
  }, []);

  const field = <K extends keyof T & string>(name: K): FieldBinding<T[K]> => ({
    id: `${id}-${name}`,
    value: values[name],
    onChange: (v) => {
      set(name, v);
    },
    onBlur: () => {
      setTouched((s) => (s.has(name) ? s : new Set(s).add(name)));
    },
    error: errorOf(name),
  });

  const issues: FormIssue[] =
    attempt === 0
      ? []
      : Object.entries({ ...found, ...fromServer }).map(([name, message]) => ({
          id: `${id}-${name}`,
          label: labels[name] ?? name,
          message,
        }));

  const submit = (): void => {
    setAttempt((n) => n + 1);
    if (Object.keys(found).length > 0 || submitting) return;
    setSubmitting(true);
    setServerError(null);
    onSubmit(values)
      .then(() => {
        setSaved(values);
        setTouched(new Set());
        setAttempt(0);
        notify.success(savedText ?? t.kit.form.saved);
      })
      .catch((e: unknown) => {
        if (isApiError(e) && e.code === "validation" && Array.isArray(e.details)) {
          const mapped: Record<string, string> = {};
          for (const d of e.details as { path?: unknown; message?: unknown }[]) {
            const key = Array.isArray(d.path) ? String(d.path[0] ?? "") : "";
            if (key && key in values && typeof d.message === "string") mapped[key] = d.message;
          }
          if (Object.keys(mapped).length > 0) {
            setFromServer(mapped);
            return;
          }
        }
        const message = isApiError(e) ? e.message : t.app.unknownError;
        setServerError(message);
        notify.error(e, { retry: submit });
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const reset = (): void => {
    setValues(saved);
    setTouched(new Set());
    setAttempt(0);
    setServerError(null);
    setFromServer({});
  };

  const markSaved = (): void => {
    setSaved(values);
  };

  return {
    id,
    values,
    set,
    field,
    issues,
    attempt,
    dirty,
    submitting,
    serverError,
    submit,
    reset,
    markSaved,
  };
}

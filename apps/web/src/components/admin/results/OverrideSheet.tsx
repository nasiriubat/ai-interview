"use client";

import { FACTOR_KEYS, SOLUTION_CLASSES, type SolutionClass } from "@aidp/shared";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Field } from "@/components/admin/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { draftFromOverride, overrideReducer, toOverridePayload } from "@/lib/analysis/override";
import { staffClient } from "@/lib/api/browser";
import type { Opportunity } from "@/lib/api/schemas";

const GENERATED = "__generated__";

export function OverrideSheet({
  opportunity: o,
  open,
  onOpenChange,
  onSaved,
}: {
  opportunity: Opportunity;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: Opportunity) => void;
}): React.JSX.Element {
  const s = t.admin.results;
  const action = useAction();
  const [draft, dispatch] = React.useReducer(overrideReducer, o.adminOverride, draftFromOverride);

  const save = (): void => {
    void action.run(async () => {
      const updated = await staffClient.opportunities.override(o.id, toOverridePayload(draft, o));
      onSaved(updated);
      onOpenChange(false);
    }, s.override.saved);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent closeLabel={t.app.close}>
        <SheetHeader>
          <SheetTitle>{s.override.title}</SheetTitle>
          <SheetDescription>{s.override.body}</SheetDescription>
        </SheetHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field id="override-title" label={s.override.titleField} hint={s.override.generated(o.title)}>
            <Input
              id="override-title"
              value={draft.title}
              placeholder={o.title}
              maxLength={160}
              aria-describedby="override-title-hint"
              onChange={(e) => {
                dispatch({ type: "title", value: e.target.value });
              }}
            />
          </Field>
          <Field
            id="override-class"
            label={s.override.classField}
            hint={s.override.generated(s.classes[o.solutionClass])}
          >
            <Select
              value={draft.solutionClass || GENERATED}
              onValueChange={(v) => {
                dispatch({ type: "class", value: v === GENERATED ? "" : (v as SolutionClass) });
              }}
            >
              <SelectTrigger id="override-class" className="w-full" aria-describedby="override-class-hint">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GENERATED}>{s.override.generated(s.classes[o.solutionClass])}</SelectItem>
                {SOLUTION_CLASSES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {s.classes[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium">{s.override.factorsField}</legend>
            {FACTOR_KEYS.map((k) => {
              const id = `override-factor-${k}`;
              const current = draft.factors[k];
              const generated = o.factors[k];
              return (
                <div key={k} className="grid gap-1.5 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor={id} className="text-sm font-medium">
                      {s.factors[k]}
                    </label>
                    <select
                      id={id}
                      value={current ? String(current.score) : GENERATED}
                      onChange={(e) => {
                        dispatch({
                          type: "factorScore",
                          key: k,
                          score: e.target.value === GENERATED ? null : Number(e.target.value),
                        });
                      }}
                      className="bg-card text-foreground shadow-control focus-visible:ring-ring/40 h-8 rounded-md border-0 px-2 text-xs outline-none focus-visible:ring-[3px]"
                    >
                      <option value={GENERATED}>{s.override.generated(`${generated.score}/5`)}</option>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}/5
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="text-muted-foreground text-xs">{generated.rationale}</p>
                  {current ? (
                    <Textarea
                      aria-label={`${s.override.rationaleField}: ${s.factors[k]}`}
                      placeholder={s.override.rationaleField}
                      rows={2}
                      value={current.rationale}
                      onChange={(e) => {
                        dispatch({ type: "factorRationale", key: k, rationale: e.target.value });
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </fieldset>

          <Field id="override-note" label={s.override.noteField}>
            <Textarea
              id="override-note"
              rows={3}
              maxLength={1000}
              value={draft.note}
              onChange={(e) => {
                dispatch({ type: "note", value: e.target.value });
              }}
            />
          </Field>

          <Flash flash={action.flash} />
          <SheetFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={action.busy}
              onClick={() => {
                dispatch({ type: "clear" });
              }}
            >
              {s.override.reset}
            </Button>
            <Button type="submit" loading={action.busy}>
              {action.busy ? t.app.saving : t.app.save}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

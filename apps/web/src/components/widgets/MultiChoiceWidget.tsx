"use client";

import type { Widget, WidgetResponse } from "@aidp/shared";
import * as React from "react";
import { OptionDetail } from "./OptionDetail";
import { OtherInput } from "./OtherInput";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChoiceTile } from "@/components/ui/choice-tile";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

export function MultiChoiceWidget({
  widget,
  disabled,
  onSubmit,
  other: withOther = true,
}: {
  widget: Extract<Widget, { type: "multi_choice" }>;
  disabled?: boolean | undefined;
  /** The "Other" field. Off where the answer box right below already takes a written answer. */
  other?: boolean | undefined;
  onSubmit: (response: WidgetResponse) => void;
}): React.JSX.Element {
  const id = React.useId();
  const [keys, setKeys] = React.useState<string[]>([]);
  const [other, setOther] = React.useState("");
  const max = widget.max;
  const atMax = max !== undefined && keys.length >= max;
  const canSubmit = !disabled && (keys.length > 0 || other.trim().length > 0);

  const toggle = (key: string, checked: boolean): void => {
    setKeys((prev) => {
      if (checked)
        return prev.includes(key) || (max !== undefined && prev.length >= max) ? prev : [...prev, key];
      return prev.filter((k) => k !== key);
    });
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        const trimmed = other.trim();
        onSubmit({ type: "multi_choice", keys, ...(trimmed ? { other: trimmed } : {}) });
      }}
    >
      <fieldset className="grid gap-2 sm:grid-cols-2" disabled={disabled}>
        <legend className="text-muted-foreground mb-1 text-xs">
          {max !== undefined ? t.participant.session.widgetMaxHint(max) : t.participant.session.widgetAnswer}
        </legend>
        {widget.options.map((o) => {
          const checked = keys.includes(o.key);
          return (
            <ChoiceTile key={o.key} as="div" className="flex-col" disabled={disabled ?? false}>
              <div className="flex w-full items-start gap-3">
                <Checkbox
                  id={`${id}-${o.key}`}
                  checked={checked}
                  disabled={(disabled ?? false) || (atMax && !checked)}
                  onCheckedChange={(v) => {
                    toggle(o.key, v === true);
                  }}
                  className="mt-0.5"
                />
                <Label htmlFor={`${id}-${o.key}`} className="min-h-5 flex-1 cursor-pointer leading-snug">
                  {o.label}
                </Label>
              </div>
              <OptionDetail id={`${id}-${o.key}-detail`} label={o.label} detail={o.detail} />
            </ChoiceTile>
          );
        })}
      </fieldset>
      {withOther ? (
        <OtherInput id={`${id}-other`} value={other} onChange={setOther} disabled={disabled} />
      ) : null}
      <Button type="submit" disabled={!canSubmit} className="w-full sm:w-auto">
        {t.participant.session.widgetSubmit}
      </Button>
    </form>
  );
}

"use client";

import type { Widget, WidgetResponse } from "@aidp/shared";
import * as React from "react";
import { OptionDetail } from "./OptionDetail";
import { OtherField, OtherInput } from "./OtherInput";
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
  /** How "Other" is offered: a separate field (`true`) or a last choice that opens one (D-482). */
  other?: boolean | undefined;
  onSubmit: (response: WidgetResponse) => void;
}): React.JSX.Element {
  const id = React.useId();
  const [keys, setKeys] = React.useState<string[]>([]);
  const [other, setOther] = React.useState("");
  const [otherPicked, setOtherPicked] = React.useState(false);
  const max = widget.max;
  const atMax = max !== undefined && keys.length + (otherPicked ? 1 : 0) >= max;
  const otherText = withOther || otherPicked ? other.trim() : "";
  const canSubmit =
    !disabled && (keys.length > 0 || otherText.length > 0) && !(otherPicked && otherText === "");

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
        onSubmit({ type: "multi_choice", keys, ...(otherText ? { other: otherText } : {}) });
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
        {!withOther ? (
          <ChoiceTile as="div" className="flex-col" disabled={disabled ?? false}>
            <div className="flex w-full items-start gap-3">
              <Checkbox
                id={`${id}-other-choice`}
                checked={otherPicked}
                disabled={(disabled ?? false) || (atMax && !otherPicked)}
                onCheckedChange={(v) => {
                  setOtherPicked(v === true);
                }}
                className="mt-0.5"
              />
              <Label htmlFor={`${id}-other-choice`} className="min-h-5 flex-1 cursor-pointer leading-snug">
                {t.participant.session.widgetOther}
              </Label>
            </div>
            {otherPicked ? (
              <OtherField id={`${id}-other`} value={other} onChange={setOther} disabled={disabled} />
            ) : null}
          </ChoiceTile>
        ) : null}
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

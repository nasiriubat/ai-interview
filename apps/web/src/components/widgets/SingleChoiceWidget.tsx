"use client";

import type { Widget, WidgetResponse } from "@aidp/shared";
import * as React from "react";
import { OptionDetail } from "./OptionDetail";
import { OtherInput } from "./OtherInput";
import { Button } from "@/components/ui/button";
import { ChoiceTile } from "@/components/ui/choice-tile";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { t } from "@/i18n";

export function SingleChoiceWidget({
  widget,
  disabled,
  onSubmit,
}: {
  widget: Extract<Widget, { type: "single_choice" }>;
  disabled?: boolean | undefined;
  onSubmit: (response: WidgetResponse) => void;
}): React.JSX.Element {
  const id = React.useId();
  const [key, setKey] = React.useState<string | undefined>(undefined);
  const [other, setOther] = React.useState("");
  const canSubmit = !disabled && (key !== undefined || other.trim().length > 0);

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        const trimmed = other.trim();
        onSubmit({ type: "single_choice", ...(key ? { key } : {}), ...(trimmed ? { other: trimmed } : {}) });
      }}
    >
      <RadioGroup
        value={key ?? ""}
        onValueChange={(v) => {
          setKey(v || undefined);
        }}
        disabled={disabled}
        aria-label={t.participant.session.widgetAnswer}
      >
        {widget.options.map((o) => (
          <ChoiceTile key={o.key} as="div" className="flex-col" disabled={disabled ?? false}>
            <div className="flex w-full items-start gap-3">
              <RadioGroupItem value={o.key} id={`${id}-${o.key}`} className="mt-0.5" />
              <Label htmlFor={`${id}-${o.key}`} className="min-h-5 flex-1 cursor-pointer leading-snug">
                {o.label}
              </Label>
            </div>
            <OptionDetail id={`${id}-${o.key}-detail`} label={o.label} detail={o.detail} />
          </ChoiceTile>
        ))}
      </RadioGroup>
      <OtherInput id={`${id}-other`} value={other} onChange={setOther} disabled={disabled} />
      <Button type="submit" disabled={!canSubmit} className="w-full sm:w-auto">
        {t.participant.session.widgetSubmit}
      </Button>
    </form>
  );
}

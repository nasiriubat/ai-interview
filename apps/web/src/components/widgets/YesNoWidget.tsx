"use client";

import type { Widget, WidgetResponse } from "@aidp/shared";
import * as React from "react";
import { OtherInput } from "./OtherInput";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** Yes / no with an optional free-text addition. Tapping Yes or No answers immediately. */
export function YesNoWidget({
  widget,
  disabled,
  onSubmit,
}: {
  widget: Extract<Widget, { type: "yes_no" }>;
  disabled?: boolean | undefined;
  onSubmit: (response: WidgetResponse) => void;
}): React.JSX.Element {
  const id = React.useId();
  const [other, setOther] = React.useState("");
  const answer = (value: boolean): void => {
    if (disabled) return;
    const trimmed = other.trim();
    onSubmit({ type: "yes_no", value, ...(trimmed ? { other: trimmed } : {}) });
  };
  return (
    <div className="grid gap-2" role="group" aria-label={t.participant.session.widgetAnswer}>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disabled}
          onClick={() => {
            answer(true);
          }}
        >
          {t.app.yes}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disabled}
          onClick={() => {
            answer(false);
          }}
        >
          {t.app.no}
        </Button>
      </div>
      {(widget.followUpOnYes ?? widget.followUpOnNo) ? (
        <p className="text-muted-foreground text-xs">{widget.followUpOnYes ?? widget.followUpOnNo}</p>
      ) : null}
      <OtherInput id={`${id}-other`} value={other} onChange={setOther} disabled={disabled} />
    </div>
  );
}

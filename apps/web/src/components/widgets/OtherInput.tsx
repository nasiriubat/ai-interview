"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";

/** The always-present "Other" entry of choice widgets. Typed for now; voice arrives in phase 4. */
export function OtherInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean | undefined;
}): React.JSX.Element {
  return (
    <div className="mt-3 grid gap-1.5">
      <Label htmlFor={id}>{t.participant.session.widgetOther}</Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={t.participant.session.widgetOtherPlaceholder}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

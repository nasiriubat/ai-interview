"use client";

import type { Widget, WidgetResponse } from "@aidp/shared";
import * as React from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

const VALUES = [1, 2, 3, 4, 5] as const;

/** A 1 to 5 scale. One tap answers; arrow keys move between values. */
export function ScaleWidget({
  widget,
  disabled,
  onSubmit,
}: {
  widget: Extract<Widget, { type: "scale" }>;
  disabled?: boolean | undefined;
  onSubmit: (response: WidgetResponse) => void;
}): React.JSX.Element {
  const [selected, setSelected] = React.useState<number | undefined>(undefined);
  const choose = (value: number): void => {
    if (disabled) return;
    setSelected(value);
    onSubmit({ type: "scale", value });
  };

  return (
    <div className="grid gap-2">
      <div
        role="radiogroup"
        aria-label={t.participant.session.widgetAnswer}
        className="grid grid-cols-5 gap-2"
      >
        {VALUES.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={selected === v}
            aria-label={t.participant.session.widgetScaleLabel(v)}
            disabled={disabled}
            tabIndex={selected === undefined ? (v === 1 ? 0 : -1) : selected === v ? 0 : -1}
            className={cn(
              "bg-card shadow-control h-12 rounded-lg text-lg font-medium transition-shadow disabled:opacity-50",
              selected === v
                ? "bg-primary text-primary-foreground shadow-[0_0_0_2px_var(--primary)]"
                : "hover:shadow-[0_0_0_1px_var(--input-hover)]",
            )}
            onClick={() => {
              choose(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = Math.min(5, (selected ?? v) + 1);
                (e.currentTarget.parentElement?.children[next - 1] as HTMLElement | undefined)?.focus();
              } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                e.preventDefault();
                const prev = Math.max(1, (selected ?? v) - 1);
                (e.currentTarget.parentElement?.children[prev - 1] as HTMLElement | undefined)?.focus();
              }
            }}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>{widget.minLabel}</span>
        <span>{widget.maxLabel}</span>
      </div>
      <p className="text-muted-foreground text-xs">{t.participant.session.widgetIgnore}</p>
    </div>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A horizontal meter: a value against a maximum, with the figure written beside it so the state is
 * never carried by the fill alone. `tone="spend"` turns amber at 80 % and red at 100 %, the
 * thresholds the budget alerts use; `tone="progress"` stays the brand colour.
 */
export function MeterBar({
  value,
  max,
  label,
  valueText,
  tone = "progress",
  className,
}: {
  value: number;
  max: number;
  /** The accessible name: what is being measured. */
  label: string;
  /** What a screen reader says for the value, such as "7 of 10 interviews". */
  valueText: string;
  tone?: "progress" | "spend";
  className?: string | undefined;
}): React.JSX.Element {
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;
  const fill =
    tone === "spend"
      ? pct >= 100
        ? "bg-destructive"
        : pct >= 80
          ? "bg-warning"
          : "bg-primary"
      : "bg-primary";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={valueText}
      aria-label={label}
      className={cn("bg-muted h-2 w-full overflow-hidden rounded-full", className)}
    >
      <div className={cn("h-full rounded-full", fill)} style={{ width: `${String(pct)}%` }} />
    </div>
  );
}

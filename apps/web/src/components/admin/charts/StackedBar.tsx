import * as React from "react";
import { cn } from "@/lib/utils";

export interface StackSegment {
  key: string;
  label: string;
  value: number;
  /** A CSS colour, normally a chart token (`var(--chart-1)`). */
  color: string;
}

/**
 * One proportional bar split into parts, with its legend underneath. The legend is the text
 * equivalent: a list of "name, count, share" that reads without the colours, so the bar itself is
 * decoration with a summary label. Zero-size parts are left out of the bar but kept in the legend.
 */
export function StackedBar({
  segments,
  label,
  format = (v) => String(v),
  className,
}: {
  segments: StackSegment[];
  /** What the whole bar is, for assistive technology ("Opportunities by solution class"). */
  label: string;
  format?: (value: number) => string;
  className?: string | undefined;
}): React.JSX.Element {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const pct = (v: number): string => (total > 0 ? `${String(Math.round((v / total) * 100))} %` : "0 %");
  const summary = segments.map((s) => `${s.label} ${format(s.value)}`).join(", ");
  return (
    <div className={cn("@container grid gap-4", className)}>
      <div
        role="img"
        aria-label={`${label}: ${summary}`}
        className="bg-muted flex h-6 w-full gap-0.5 overflow-hidden rounded-md"
      >
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <span
              key={s.key}
              className="h-full first:rounded-l-md last:rounded-r-md"
              style={{ flexGrow: s.value, flexBasis: 0, backgroundColor: s.color }}
            />
          ))}
      </div>
      <ul className="grid grid-cols-1 gap-x-8 gap-y-2.5 text-[13px] @lg:grid-cols-2" aria-label={label}>
        {segments.map((s) => (
          <li key={s.key} className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="size-3 shrink-0 rounded-[3px]"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-foreground min-w-0 truncate">{s.label}</span>
            <span className="text-foreground ml-auto font-medium tabular-nums">{format(s.value)}</span>
            <span className="text-muted-foreground w-11 shrink-0 text-right text-xs whitespace-nowrap tabular-nums">
              {pct(s.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

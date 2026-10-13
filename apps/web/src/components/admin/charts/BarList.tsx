import * as React from "react";

export interface BarListItem {
  key: string;
  label: string;
  value: number;
  /** What is printed at the end of the row; defaults to the raw value. */
  display?: string | undefined;
  /** Optional second figure in muted ink, e.g. the call count beside a cost. */
  detail?: string | undefined;
}

/**
 * Ranked horizontal bars: one hue, magnitude only (dataviz: sequential job, single series, so no
 * legend). Every value is printed as text beside its bar, so the chart reads without colour and
 * is already its own table view: it is a `<ul>`, and a screen reader gets label and value per row.
 */
export function BarList({
  items,
  label,
  sort = true,
}: {
  items: BarListItem[];
  /** Accessible name of the list. */
  label: string;
  sort?: boolean;
}): React.JSX.Element {
  const rows = sort ? [...items].sort((a, b) => b.value - a.value) : items;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="grid gap-2.5">
      {rows.map((r) => {
        const pct = (r.value / max) * 100;
        return (
          <li
            key={r.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 text-[13px]"
          >
            <span className="text-foreground truncate">{r.label}</span>
            <span className="text-foreground text-right font-medium tabular-nums">
              {r.display ?? r.value}
              {r.detail ? <span className="text-muted-foreground ml-2 font-normal">{r.detail}</span> : null}
            </span>
            <span aria-hidden="true" className="bg-muted col-span-2 h-1.5 overflow-hidden rounded-full">
              <span
                className="bg-primary block h-full rounded-full"
                style={{ width: `${r.value > 0 ? Math.max(pct, 1.5) : 0}%` }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

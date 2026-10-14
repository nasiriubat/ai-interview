import * as React from "react";
import { Withheld } from "./Withheld";
import { cn } from "@/lib/utils";

export interface MatrixCell {
  /** The value that sets the intensity; null leaves the cell empty. */
  value: number | null;
  /** What is printed in the cell. */
  display?: string | undefined;
  withheld?: boolean | undefined;
}

export interface MatrixRow {
  key: string;
  label: React.ReactNode;
  /** Shown under the label, in muted ink. */
  detail?: string | undefined;
  cells: MatrixCell[];
}

/**
 * A matrix of numbers whose cells are tinted by magnitude (one hue, light to strong). It is a real
 * `<table>`: every cell prints its number, so the tint is redundant encoding and the matrix is its
 * own accessible table. Withheld cells carry the lock treatment instead of a number. The first
 * column sticks while the rest scrolls inside the card on a narrow screen.
 */
export function HeatMatrix({
  caption,
  corner,
  columns,
  rows,
  max,
  min = 0,
  withheldReason,
  className,
}: {
  caption: string;
  corner: string;
  columns: { key: string; label: string; title?: string | undefined }[];
  rows: MatrixRow[];
  max: number;
  min?: number;
  withheldReason?: string | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  const span = Math.max(0.0001, max - min);
  const tint = (v: number): string => {
    const share = Math.min(1, Math.max(0, (v - min) / span));
    // 8 % to 58 % of the primary over the card: legible text on every step, light and dark.
    return `color-mix(in srgb, var(--primary) ${String(Math.round(8 + share * 50))}%, var(--card))`;
  };
  return (
    <div
      className={cn("relative overflow-x-auto", className)}
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="w-full border-separate border-spacing-0.5 text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="bg-card text-muted-foreground sticky left-0 z-10 min-w-28 p-1.5 text-left text-xs font-medium sm:min-w-36"
            >
              {corner}
            </th>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                title={c.title ?? c.label}
                className="text-muted-foreground min-w-12 px-0.5 py-1.5 text-center sm:min-w-14 sm:px-1 text-xs leading-tight font-medium"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th
                scope="row"
                className="bg-card text-foreground sticky left-0 z-10 max-w-36 min-w-28 p-1.5 text-left text-[13px] font-medium sm:max-w-56"
              >
                <span className="line-clamp-2 break-words">{r.label}</span>
                {r.detail ? (
                  <span className="text-muted-foreground block text-xs font-normal">{r.detail}</span>
                ) : null}
              </th>
              {r.cells.map((c, i) => (
                <td
                  key={columns[i]?.key ?? i}
                  className="h-10 rounded-md px-1 text-center align-middle font-medium tabular-nums"
                  style={c.value !== null && !c.withheld ? { backgroundColor: tint(c.value) } : undefined}
                >
                  {c.withheld ? (
                    <Withheld compact reason={withheldReason} />
                  ) : c.value === null ? (
                    <span className="text-muted-foreground">·</span>
                  ) : (
                    <span className="text-foreground">{c.display ?? String(c.value)}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

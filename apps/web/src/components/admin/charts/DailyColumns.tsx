"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface DailyPoint {
  day: string;
  value: number;
  tooltip: string;
}

/**
 * Change over time as columns, one per day (single series, one hue, recessive grid). Each column
 * has a hover target the full height of the plot, wider than the mark, with a tooltip. The columns
 * are not focusable — thirty tab stops to cross one chart would be worse than none — so the same
 * numbers are in a visually hidden table that assistive tech reads instead of the drawing.
 */
export function DailyColumns({
  points,
  label,
  axisStart,
  axisEnd,
}: {
  points: DailyPoint[];
  label: string;
  axisStart: string;
  axisEnd: string;
}): React.JSX.Element {
  const max = Math.max(...points.map((p) => p.value), 0);
  return (
    <figure aria-label={label} className="grid gap-2">
      <div className="relative h-36">
        {/* Recessive gridlines at 0, 50 and 100 % of the tallest day. */}
        <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">
          <span className="border-border/70 border-t border-dashed" />
          <span className="border-border/70 border-t border-dashed" />
          <span className="border-border border-t" />
        </div>
        <ol aria-hidden="true" className="relative flex h-full items-end gap-[2px]">
          {points.map((p) => {
            const h = max > 0 ? (p.value / max) * 100 : 0;
            return (
              <li key={p.day} className="flex h-full min-w-0 flex-1 items-end">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="group flex h-full w-full items-end">
                      <span
                        className="bg-primary/80 group-hover:bg-primary block w-full rounded-t-[4px] transition-colors"
                        style={{ height: p.value > 0 ? `max(${h}%, 2px)` : "0" }}
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{p.tooltip}</TooltipContent>
                </Tooltip>
              </li>
            );
          })}
        </ol>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.day}>
              <td>{p.tooltip}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <figcaption
        aria-hidden="true"
        className="text-muted-foreground flex justify-between text-xs tabular-nums"
      >
        <span>{axisStart}</span>
        <span>{axisEnd}</span>
      </figcaption>
    </figure>
  );
}

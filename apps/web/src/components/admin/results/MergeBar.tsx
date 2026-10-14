"use client";

import { MergeIcon, XIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/**
 * The sticky bar that appears when cards are selected for merging. It says how many are selected,
 * and why Merge is not available yet (fewer than two, or more than the API takes) in words next to
 * the button, not only by disabling it.
 */
export function MergeBar({
  count,
  max,
  onMerge,
  onClear,
}: {
  count: number;
  max: number;
  onMerge: () => void;
  onClear: () => void;
}): React.JSX.Element | null {
  const s = t.admin.results.merge;
  if (count === 0) return null;
  const hint = count < 2 ? s.needTwo : count > max ? s.tooMany(max) : null;
  return (
    <div
      role="region"
      aria-label={s.barLabel}
      className="bg-card shadow-raised sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 print:hidden"
    >
      <div className="grid gap-0.5">
        <p className="text-sm font-medium" aria-live="polite">
          {s.selected(count)}
        </p>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onClear}>
          <XIcon /> {s.clear}
        </Button>
        <Button size="sm" disabled={count < 2 || count > max} onClick={onMerge}>
          <MergeIcon /> {s.mergeSelected(count)}
        </Button>
      </div>
    </div>
  );
}

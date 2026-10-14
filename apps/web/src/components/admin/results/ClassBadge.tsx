import type { SolutionClass } from "@aidp/shared";
import * as React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { t } from "@/i18n";

const TONES: Record<SolutionClass, BadgeProps["variant"]> = {
  ai: "default",
  automation: "secondary",
  software: "secondary",
  process: "warning",
  none: "outline",
};

export function ClassBadge({ solutionClass }: { solutionClass: SolutionClass }): React.JSX.Element {
  return <Badge variant={TONES[solutionClass]}>{t.admin.results.classes[solutionClass]}</Badge>;
}

export function RankMeter({
  score,
  compact = false,
}: {
  score: number;
  compact?: boolean;
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={t.admin.results.rankOf(pct)}
      className="flex items-center gap-2"
    >
      <div
        className={
          compact
            ? "bg-muted h-1.5 w-14 overflow-hidden rounded-full"
            : "bg-muted h-2 w-24 overflow-hidden rounded-full"
        }
      >
        <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
      </div>
      <span className={compact ? "text-xs font-medium tabular-nums" : "text-sm font-semibold tabular-nums"}>
        {pct}
      </span>
    </div>
  );
}

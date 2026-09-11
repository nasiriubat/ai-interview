"use client";

import type { Path } from "@aidp/shared";
import { CodeIcon, MessageCircleIcon } from "lucide-react";
import * as React from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The two path cards (technical / nontechnical). Without `value` each card is a one-shot
 * choice (arrival flows); with `value` the cards act as a toggle group (forms).
 */
export function PathChoice({
  value,
  onChoose,
  disabled = false,
  compact = false,
}: {
  value?: Path | undefined;
  onChoose: (path: Path) => void;
  disabled?: boolean;
  compact?: boolean;
}): React.JSX.Element {
  const options = [
    ["technical", t.participant.path.technical, t.participant.path.technicalHint, CodeIcon],
    ["nontechnical", t.participant.path.nontechnical, t.participant.path.nontechnicalHint, MessageCircleIcon],
  ] as const;
  return (
    <div className={cn("grid gap-3", compact && "sm:grid-cols-2")}>
      {options.map(([path, label, hint, Icon]) => {
        const selected = value === path;
        return (
          <button
            key={path}
            type="button"
            disabled={disabled}
            aria-pressed={value !== undefined ? selected : undefined}
            className={cn(
              "hover:bg-accent focus-visible:ring-ring/50 flex items-start gap-4 rounded-xl border p-4 text-left transition-colors focus-visible:ring-[3px] disabled:opacity-50",
              selected && "border-primary bg-accent",
            )}
            onClick={() => {
              onChoose(path);
            }}
          >
            <Icon className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
            <span className="grid gap-1">
              <span className={cn("font-semibold", compact ? "text-base" : "text-lg")}>{label}</span>
              <span className="text-muted-foreground text-sm">{hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

import { LockIcon } from "lucide-react";
import * as React from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * "Not shown, on purpose": a number or a quote the anonymity rule keeps back (FR-17, k-anonymity).
 * It looks deliberate, a lock and a word on a hatched ground, so a person never mistakes it for a
 * zero or for something that failed to load. `reason` is the sentence for assistive technology and
 * the tooltip text; the visible word stays short.
 */
export function Withheld({
  reason,
  compact = false,
  className,
}: {
  reason?: string | undefined;
  compact?: boolean;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <span
      data-withheld
      title={reason}
      className={cn(
        "text-muted-foreground bg-muted/60 relative inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium",
        "[background-image:repeating-linear-gradient(135deg,transparent_0_5px,color-mix(in_srgb,var(--muted-foreground)_16%,transparent)_5px_6px)]",
        compact && "px-1",
        className,
      )}
    >
      <LockIcon className="size-3 shrink-0" aria-hidden="true" />
      {t.ws.withheld.word}
      {reason ? <span className="sr-only">: {reason}</span> : null}
    </span>
  );
}

import { FACTOR_KEYS, type Factors } from "@aidp/shared";
import * as React from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** The seven factors as a compact row of five-segment bars; the rationale is the hover title. */
export function FactorBars({
  factors,
  overridden = [],
  className,
}: {
  factors: Factors;
  overridden?: readonly string[];
  className?: string;
}): React.JSX.Element {
  const s = t.admin.results;
  return (
    <ul className={cn("grid grid-cols-7 gap-1.5", className)} aria-label={s.factorsLabel}>
      {FACTOR_KEYS.map((k) => {
        const f = factors[k];
        const label = s.factors[k];
        const edited = overridden.includes(k);
        return (
          <li
            key={k}
            className="min-w-0"
            title={`${s.factorScore(label, f.score)}${f.rationale ? ` — ${f.rationale}` : ""}`}
          >
            <span className="sr-only">{s.factorScore(label, f.score)}</span>
            <div className="flex gap-0.5" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  className={cn(
                    "h-1.5 flex-1 rounded-sm",
                    n <= f.score ? (edited ? "bg-amber-500" : "bg-primary") : "bg-muted",
                  )}
                />
              ))}
            </div>
            <span
              className="text-muted-foreground mt-1 block truncate text-[10px] leading-tight"
              aria-hidden="true"
            >
              {label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

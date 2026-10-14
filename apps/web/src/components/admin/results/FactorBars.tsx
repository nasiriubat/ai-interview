import { FACTOR_KEYS, type Factors } from "@aidp/shared";
import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The seven factors as a compact row of five-segment bars. The rationale is reachable by keyboard:
 * each factor is a button, so Tab lands on it and the tooltip opens on focus as well as on hover,
 * and a screen reader hears the score and the rationale together (a `title` did neither).
 */
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
    <ul className={cn("grid grid-cols-4 gap-1.5 sm:grid-cols-7", className)} aria-label={s.factorsLabel}>
      {FACTOR_KEYS.map((k) => {
        const f = factors[k];
        const label = s.factors[k];
        const edited = overridden.includes(k);
        const score = s.factorScore(label, f.score);
        return (
          <li key={k} className="min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={f.rationale ? `${score}. ${f.rationale}` : score}
                  className="block w-full min-w-0 rounded-sm text-left"
                >
                  <span className="flex gap-0.5" aria-hidden="true">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <span
                        key={n}
                        className={cn(
                          "h-1.5 flex-1 rounded-sm",
                          n <= f.score ? (edited ? "bg-warning" : "bg-primary") : "bg-muted",
                        )}
                      />
                    ))}
                  </span>
                  <span
                    className="text-muted-foreground mt-1 block truncate text-[10px] leading-tight"
                    aria-hidden="true"
                  >
                    {label}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs" side="top">
                <span className="block font-medium">{score}</span>
                {f.rationale ? <span className="block">{f.rationale}</span> : null}
              </TooltipContent>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

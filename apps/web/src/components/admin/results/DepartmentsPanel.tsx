import { SOLUTION_CLASSES, type DepartmentComparison, type DepartmentRow } from "@aidp/shared";
import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { Inset } from "@/components/ui/inset";
import { t } from "@/i18n";
import { formatNumber, formatPercent } from "@/lib/utils";

const COMPARED = SOLUTION_CLASSES.filter((c) => c !== "none");

function rowName(r: DepartmentRow): string {
  const s = t.admin.results.departments;
  if (r.kind === "other") return s.other;
  return r.name ?? s.unspecified;
}

/**
 * Department comparison under the anonymity rule (FR-17). Every share is a number printed in its
 * cell, never colour alone. When the API did not show the comparison, this says why and what k is,
 * so an empty panel is an explanation rather than a mystery.
 */
export function DepartmentsPanel({
  comparison,
  error,
}: {
  comparison: DepartmentComparison | null;
  error?: boolean;
}): React.JSX.Element {
  const s = t.admin.results.departments;
  if (!comparison) {
    return (
      <Panel title={s.title} headingLevel={3}>
        <p className="text-muted-foreground px-5 py-4 text-sm">
          {error ? s.loadError : s.reasons.rerun_required}
        </p>
      </Panel>
    );
  }
  const reason = comparison.reason
    ? comparison.reason === "too_few_eligible"
      ? s.reasons.too_few_eligible(comparison.k)
      : s.reasons[comparison.reason]
    : null;
  return (
    <Panel title={s.title} description={s.body(comparison.k)} headingLevel={3}>
      {comparison.shown ? (
        <div className="grid gap-3 px-5 py-4">
          {/*
           * One card per group rather than one table row: the panel lives in a column a third of the
           * page wide, where eight columns clipped their text on the right and put "Described by many"
           * in a strip a word wide. A card wraps at any width, and each number still sits next to its
           * own name (D-321).
           */}
          <ul className="grid gap-3" aria-label={s.title}>
            {comparison.departments.map((r) => (
              <Inset as="li" key={`${r.kind}-${r.name ?? ""}`} className="min-w-0">
                <h4 className="text-[13px] font-semibold break-words">{rowName(r)}</h4>
                <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{s.participants}</dt>
                    <dd className="font-medium tabular-nums">{formatNumber(r.participants)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{s.hours}</dt>
                    <dd className="font-medium tabular-nums">
                      {formatNumber(Math.round(r.minutesPerWeek / 60))}
                    </dd>
                  </div>
                </dl>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {COMPARED.map((c) => {
                    const v = r.solutionClassShare[c];
                    return (
                      <div key={c} className="flex min-w-0 items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground min-w-0 break-words">
                          <span className="sr-only">{s.classShare}: </span>
                          {t.admin.results.classes[c]}
                        </dt>
                        <dd className="shrink-0 tabular-nums">
                          {v === undefined ? (
                            <span className="text-muted-foreground">{s.withheld}</span>
                          ) : (
                            formatPercent(v, 0)
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                <p className="text-muted-foreground mt-2 text-xs break-words [overflow-wrap:anywhere]">
                  <span className="font-medium">{s.mostShared}: </span>
                  {r.topOpportunities.length > 0
                    ? r.topOpportunities.map((o) => `${o.title} (${formatPercent(o.share, 0)})`).join("; ")
                    : s.none}
                </p>
              </Inset>
            ))}
          </ul>
          {comparison.belowK > 0 ? (
            <p className="text-muted-foreground text-xs">{s.hidden(comparison.belowK, comparison.k)}</p>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-1 px-5 py-4 text-sm">
          <p className="font-medium">{s.notShown}</p>
          <p className="text-muted-foreground">{reason}</p>
          {comparison.belowK > 0 ? (
            <p className="text-muted-foreground text-xs">{s.hidden(comparison.belowK, comparison.k)}</p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

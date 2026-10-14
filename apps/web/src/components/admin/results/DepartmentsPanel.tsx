import { SOLUTION_CLASSES, type DepartmentComparison, type DepartmentRow } from "@aidp/shared";
import * as React from "react";
import { Panel } from "@/components/admin/Panel";
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
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <caption className="sr-only">{s.title}</caption>
              <thead>
                <tr className="text-muted-foreground text-xs">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {s.title}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">
                    {s.participants}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">
                    {s.hours}
                  </th>
                  {COMPARED.map((c) => (
                    <th key={c} scope="col" className="px-2 py-1.5 text-right font-medium">
                      <span className="sr-only">{s.classShare}: </span>
                      {t.admin.results.classes[c]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.departments.map((r) => (
                  <React.Fragment key={`${r.kind}-${r.name ?? ""}`}>
                    <tr className="border-t">
                      <th scope="row" className="py-2 pr-3 font-medium">
                        {rowName(r)}
                      </th>
                      <td className="px-2 py-2 text-right tabular-nums">{formatNumber(r.participants)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatNumber(Math.round(r.minutesPerWeek / 60))}
                      </td>
                      {COMPARED.map((c) => {
                        const v = r.solutionClassShare[c];
                        return (
                          <td key={c} className="px-2 py-2 text-right tabular-nums">
                            {v === undefined ? (
                              <span className="text-muted-foreground">{s.withheld}</span>
                            ) : (
                              formatPercent(v, 0)
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td colSpan={3 + COMPARED.length} className="text-muted-foreground pb-2 text-xs">
                        <span className="font-medium">{s.mostShared}: </span>
                        {r.topOpportunities.length > 0
                          ? r.topOpportunities
                              .map((o) => `${o.title} (${formatPercent(o.share, 0)})`)
                              .join("; ")
                          : s.none}
                      </td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
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

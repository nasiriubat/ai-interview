import { SOLUTION_CLASSES, type DepartmentComparison, type DepartmentRow } from "@aidp/shared";
import { AlertTriangleIcon, ShieldCheckIcon } from "lucide-react";
import * as React from "react";
import { HeatMatrix } from "@/components/admin/charts/HeatMatrix";
import { CLASS_COLOR } from "@/components/admin/charts/palette";
import { Withheld } from "@/components/admin/charts/Withheld";
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
 * cell, never colour alone; a share the rule keeps back is a visible "Withheld" cell, not a blank
 * or a zero. When the API did not show the comparison, this says why and what k is, so an empty
 * panel is an explanation rather than a mystery.
 *
 * The layout fixes the demo's two defects (D-321): the "Most shared" opportunities are a list under
 * each department, wrapped in the card's own width rather than a column a word wide, and the
 * comparison across departments is a matrix whose first column sticks instead of clipping.
 */
export function DepartmentsPanel({
  comparison,
  error,
}: {
  comparison: DepartmentComparison | null;
  error?: boolean;
}): React.JSX.Element {
  const s = t.admin.results.departments;
  const w = t.ws.departments;
  if (!comparison) {
    return (
      <Panel title={s.title} headingLevel={2}>
        <div className="flex items-start gap-3 px-5 py-5 text-sm">
          <AlertTriangleIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="text-muted-foreground">{error ? s.loadError : s.reasons.rerun_required}</p>
        </div>
      </Panel>
    );
  }
  const reason = comparison.reason
    ? comparison.reason === "too_few_eligible"
      ? s.reasons.too_few_eligible(comparison.k)
      : s.reasons[comparison.reason]
    : null;

  if (!comparison.shown) {
    return (
      <Panel title={s.title} description={s.body(comparison.k)} headingLevel={2}>
        <div className="grid justify-items-center gap-3 px-5 py-10 text-center" data-withheld-state>
          <span className="bg-muted text-muted-foreground grid size-12 place-items-center rounded-full">
            <ShieldCheckIcon className="size-6" aria-hidden="true" />
          </span>
          <div className="max-w-md">
            <p className="text-foreground text-[15px] font-semibold">{s.notShown}</p>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{reason}</p>
          </div>
          {comparison.belowK > 0 ? (
            <p className="text-muted-foreground text-xs">{s.hidden(comparison.belowK, comparison.k)}</p>
          ) : null}
          <p className="text-muted-foreground max-w-md text-xs">{w.whyHidden}</p>
        </div>
      </Panel>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Panel title={w.matrixTitle} description={s.body(comparison.k)} headingLevel={2}>
        <div className="grid gap-3 px-5 py-4">
          <HeatMatrix
            caption={w.matrixCaption}
            corner={s.title}
            columns={COMPARED.map((c) => ({ key: c, label: t.admin.results.classes[c] }))}
            rows={comparison.departments.map((r) => ({
              key: `${r.kind}-${r.name ?? ""}`,
              label: rowName(r),
              detail: `${w.people(r.participants)} · ${w.hours(Math.round(r.minutesPerWeek / 60))}`,
              cells: COMPARED.map((c) => {
                const v = r.solutionClassShare[c];
                return v === undefined
                  ? { value: null, withheld: true }
                  : { value: v, display: formatPercent(v, 0) };
              }),
            }))}
            min={0}
            max={1}
            withheldReason={w.cellReason(comparison.k)}
          />
          <ul className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <li className="flex items-center gap-1.5">
              <Withheld compact />
              {w.legendWithheld(comparison.k)}
            </li>
            {comparison.belowK > 0 ? <li>{s.hidden(comparison.belowK, comparison.k)}</li> : null}
          </ul>
        </div>
      </Panel>

      <ul aria-label={s.title} className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        {comparison.departments.map((r) => (
          <li key={`${r.kind}-${r.name ?? ""}`} className="bg-card shadow-card min-w-0 rounded-lg px-5 py-4">
            <h3 className="text-[15px] leading-snug font-semibold break-words">{rowName(r)}</h3>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">{s.participants}</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatNumber(r.participants)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">{s.hours}</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {formatNumber(Math.round(r.minutesPerWeek / 60))}
                </dd>
              </div>
            </dl>
            <div
              role="img"
              aria-label={`${s.classShare}: ${COMPARED.filter((c) => r.solutionClassShare[c] !== undefined)
                .map((c) => `${t.admin.results.classes[c]} ${formatPercent(r.solutionClassShare[c] ?? 0, 0)}`)
                .join(", ")}`}
              className="bg-muted mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full"
            >
              {COMPARED.map((c) => {
                const v = r.solutionClassShare[c];
                return v ? (
                  <span
                    key={c}
                    className="h-full"
                    style={{ flexGrow: v, flexBasis: 0, backgroundColor: CLASS_COLOR[c] }}
                  />
                ) : null;
              })}
            </div>
            <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={s.classShare}>
              {COMPARED.map((c) => {
                const v = r.solutionClassShare[c];
                return (
                  <li key={c} className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-2.5 rounded-[3px]"
                      style={{ backgroundColor: CLASS_COLOR[c] }}
                    />
                    <span className="text-muted-foreground">{t.admin.results.classes[c]}</span>
                    {v === undefined ? (
                      <Withheld compact reason={w.cellReason(comparison.k)} />
                    ) : (
                      <span className="text-foreground font-medium tabular-nums">{formatPercent(v, 0)}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <h4 className="text-muted-foreground mt-4 text-xs font-semibold tracking-wide uppercase">
              {s.mostShared}
            </h4>
            {r.topOpportunities.length > 0 ? (
              <ol className="mt-2 grid gap-2 text-[13px]">
                {r.topOpportunities.map((o) => (
                  <li
                    key={o.clusterKey}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3"
                  >
                    <span className="min-w-0 leading-snug break-words [overflow-wrap:anywhere]">
                      {o.title}
                    </span>
                    <span className="text-foreground font-medium tabular-nums">
                      {formatPercent(o.share, 0)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-muted-foreground mt-2 text-[13px]">{s.none}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

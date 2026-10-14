"use client";

import { BarChart3Icon, TableIcon } from "lucide-react";
import * as React from "react";
import { Panel } from "@/components/admin/Panel";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/**
 * A panel for one chart with a switch to the same numbers as a table (D-371). The table is the
 * accessible fallback and also what a person copies into a spreadsheet; print always shows the
 * chart. Charts that are already tables of numbers (the factor matrix) pass no `table`, and the
 * switch is not drawn.
 */
export function ChartPanel({
  id,
  title,
  description,
  chart,
  table,
  actions,
  className,
}: {
  id: string;
  title: string;
  description?: string | undefined;
  chart: React.ReactNode;
  table?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string | undefined;
}): React.JSX.Element {
  const [view, setView] = React.useState<"chart" | "table">("chart");
  const s = t.ws.chart;
  return (
    <Panel
      id={id}
      title={title}
      description={description}
      className={className}
      actions={
        <>
          {actions}
          {table ? (
            <div role="group" aria-label={s.view} className="bg-muted flex rounded-md p-0.5 print:hidden">
              {(
                [
                  ["chart", s.chart, BarChart3Icon],
                  ["table", s.table, TableIcon],
                ] as const
              ).map(([key, label, Icon]) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={view === key ? "secondary" : "ghost"}
                  aria-pressed={view === key}
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setView(key);
                  }}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      }
    >
      <div className="px-5 py-4">
        {view === "table" && table ? (
          <>
            <div className="print:hidden">{table}</div>
            <div className="hidden print:block">{chart}</div>
          </>
        ) : (
          chart
        )}
      </div>
    </Panel>
  );
}

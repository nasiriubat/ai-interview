import type { DiffLine } from "@aidp/shared";
import * as React from "react";
import { t } from "@/i18n";
import { foldUnchanged } from "@/lib/admin/lineDiff";
import { cn } from "@/lib/utils";

/**
 * A line-by-line comparison. Each changed line carries a "+" or "−" mark and a hidden word as well
 * as its tint, so the change is readable without colour (D-235). The region is focusable so a
 * keyboard user can scroll it. Long unchanged stretches fold into one row.
 */
export function PromptDiff({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  const s = t.admin.prompts.detail;
  const rows = foldUnchanged(lines);
  const changed = lines.some((l) => l.type !== "same");
  if (!changed) return <p className="text-muted-foreground text-sm">{s.diffNone}</p>;
  return (
    <div
      role="region"
      aria-label={s.diffRegion}
      tabIndex={0}
      className="bg-card shadow-control max-h-96 overflow-auto rounded-md font-mono text-xs leading-5"
    >
      {rows.map((row, i) =>
        row.type === "fold" ? (
          <div
            key={`fold-${String(i)}`}
            className="bg-muted text-muted-foreground px-3 py-1 font-sans italic select-none"
          >
            {s.foldedLines(row.count)}
          </div>
        ) : (
          <div
            key={`${String(i)}-${row.type}`}
            className={cn(
              "flex gap-2 px-3 whitespace-pre-wrap",
              row.type === "add" && "bg-success-soft text-success-soft-foreground",
              row.type === "del" && "bg-destructive-soft text-destructive-soft-foreground",
            )}
          >
            <span aria-hidden="true" className="w-3 shrink-0 select-none">
              {row.type === "add" ? "+" : row.type === "del" ? "−" : " "}
            </span>
            {row.type !== "same" ? (
              <span className="sr-only">{row.type === "add" ? s.diffAdded : s.diffRemoved}: </span>
            ) : null}
            <span className="min-w-0 break-words">{row.text === "" ? " " : row.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

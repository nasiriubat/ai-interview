import * as React from "react";
import { EnumLabel } from "@/components/common/EnumLabel";
import { t } from "@/i18n";
import type { TemplateDiff as Diff } from "@/lib/api/schemas";

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object" && part in cur) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function show(v: unknown): string {
  if (v === undefined) return "–";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

/** Field-by-field comparison of the tenant's template against the shipped version. */
export function TemplateDiff({ diff }: { diff: Diff }): React.JSX.Element {
  const s = t.admin.templates;
  if (diff.changedFields.length === 0) return <p className="text-muted-foreground text-sm">{s.diffNone}</p>;
  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-sm">{s.diffChanged(diff.changedFields.length)}</p>
      {diff.changedFields.map((field) => (
        <div key={field} className="grid gap-2 rounded-lg border p-3 md:grid-cols-2">
          <p className="text-sm font-medium md:col-span-2">
            <EnumLabel kind="templateField" value={field} />
          </p>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">{s.shipped}</p>
            <pre className="bg-muted max-h-60 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
              {show(pick(diff.shipped, field))}
            </pre>
          </div>
          <div>
            <p className="text-muted-foreground mb-1 text-xs">{s.current}</p>
            <pre className="bg-muted max-h-60 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
              {show(pick(diff.current, field))}
            </pre>
          </div>
        </div>
      ))}
    </div>
  );
}

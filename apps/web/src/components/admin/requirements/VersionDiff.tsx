"use client";

import { Loader2Icon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { errorMessage } from "@/lib/api/errors";
import type { SpecDiff, SpecDiffSection, SpecRequirementRecord, SpecVersionSummary } from "@/lib/api/schemas";
import { sectionTitle } from "@/lib/requirements/labels";
import { cn } from "@/lib/utils";

const CHANGE_VARIANT: Record<SpecDiffSection["change"], BadgeProps["variant"]> = {
  added: "success",
  removed: "destructive",
  changed: "warning",
};

function LineDiff({ section }: { section: SpecDiffSection }): React.JSX.Element {
  const s = t.admin.requirements.version.compare;
  return (
    <div
      role="region"
      aria-label={s.lineDiff(sectionTitle(section.key, section.title))}
      className="max-h-96 overflow-auto rounded-md border font-mono text-xs"
    >
      <table className="w-full border-collapse">
        <tbody>
          {section.lines.map((line, i) => (
            <tr
              key={i}
              className={cn(
                line.type === "add" && "bg-emerald-50 text-emerald-900",
                line.type === "del" && "bg-red-50 text-red-900",
              )}
            >
              <td
                className="text-muted-foreground w-6 border-r px-1.5 text-center select-none"
                aria-hidden="true"
              >
                {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
              </td>
              <td className="px-2 py-0.5 whitespace-pre-wrap">
                {line.type !== "same" ? (
                  <span className="sr-only">{line.type === "add" ? s.addedLine : s.removedLine}: </span>
                ) : null}
                {line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequirementRows({
  items,
  tone,
}: {
  items: SpecRequirementRecord[];
  tone: "add" | "del";
}): React.JSX.Element {
  return (
    <ul className="grid gap-1 text-sm">
      {items.map((r) => (
        <li key={r.id} className={cn("rounded-md px-2 py-1", tone === "add" ? "bg-emerald-50" : "bg-red-50")}>
          <span className="text-muted-foreground mr-2 font-mono text-xs">{r.id}</span>
          {r.title}
          <Badge variant="outline" className="ml-2">
            {r.scope}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** Compares this version with another finished one: section changes with line diffs, requirement changes. */
export function VersionDiff({
  sessionId,
  current,
  others,
}: {
  sessionId: string;
  current: SpecVersionSummary;
  others: SpecVersionSummary[];
}): React.JSX.Element {
  const s = t.admin.requirements.version.compare;
  const [other, setOther] = React.useState("");
  const [diff, setDiff] = React.useState<SpecDiff | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!other) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    staffClient.requirements.versions
      .diff(sessionId, current.version, other)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e, t.app.unknownError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, current.version, other]);

  const req = diff?.requirements;
  const empty =
    diff !== null &&
    diff.sections.length === 0 &&
    (req?.added.length ?? 0) + (req?.removed.length ?? 0) + (req?.changed.length ?? 0) === 0;

  return (
    <section aria-label={s.title} className="grid gap-4 rounded-xl border p-4 print:hidden">
      <div>
        <h2 className="text-base font-semibold">{s.title}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{s.body}</p>
      </div>
      {others.length === 0 ? (
        <p className="text-muted-foreground text-sm">{s.noOther}</p>
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor="compare-version">{s.title}</Label>
          <select
            id="compare-version"
            value={other}
            onChange={(e) => {
              setOther(e.target.value);
            }}
            className="border-input bg-background focus-visible:ring-ring/50 h-9 w-full max-w-xs rounded-md border px-2 text-sm outline-none focus-visible:ring-[3px]"
          >
            <option value="">{s.none}</option>
            {others.map((v) => (
              <option key={v.id} value={v.version}>
                {t.admin.requirements.versions.versionOption(v.version, v.label)}
              </option>
            ))}
          </select>
        </div>
      )}
      {loading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{" "}
          {s.loading}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {empty ? <p className="text-muted-foreground text-sm">{s.noChanges}</p> : null}

      {diff && diff.sections.length > 0 ? (
        <div className="grid gap-4">
          <h3 className="text-sm font-semibold">{s.sections}</h3>
          {diff.sections.map((section) => (
            <div key={section.key} className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{sectionTitle(section.key, section.title)}</span>
                <Badge variant={CHANGE_VARIANT[section.change]}>{s[section.change]}</Badge>
              </div>
              {section.lines.length > 0 ? <LineDiff section={section} /> : null}
            </div>
          ))}
        </div>
      ) : null}

      {req && (req.added.length > 0 || req.removed.length > 0 || req.changed.length > 0) ? (
        <div className="grid gap-4">
          <h3 className="text-sm font-semibold">{s.requirements}</h3>
          {req.added.length > 0 ? (
            <div className="grid gap-1">
              <p className="text-muted-foreground text-xs font-medium">
                {s.added} ({req.added.length})
              </p>
              <RequirementRows items={req.added} tone="add" />
            </div>
          ) : null}
          {req.removed.length > 0 ? (
            <div className="grid gap-1">
              <p className="text-muted-foreground text-xs font-medium">
                {s.removed} ({req.removed.length})
              </p>
              <RequirementRows items={req.removed} tone="del" />
            </div>
          ) : null}
          {req.changed.length > 0 ? (
            <div className="grid gap-1">
              <p className="text-muted-foreground text-xs font-medium">
                {s.changed} ({req.changed.length})
              </p>
              <ul className="grid gap-2 text-sm">
                {req.changed.map(({ before, after }) => (
                  <li key={after.id} className="grid gap-1 rounded-md border p-2">
                    <span className="text-muted-foreground font-mono text-xs">{after.id}</span>
                    <span className="text-red-900 line-through">
                      {before.title} · {before.scope}
                    </span>
                    <span className="text-emerald-900">
                      {after.title} · {after.scope}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

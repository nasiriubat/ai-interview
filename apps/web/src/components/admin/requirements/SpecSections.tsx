"use client";

import * as React from "react";
import { SpecSectionCard } from "./SpecSectionCard";
import { StatTile } from "@/components/admin/StatTile";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import type { LiveSpec } from "@/lib/api/schemas";
import { humanize } from "@/lib/utils";

/** The Spec tab: context answers, MVP challenge state, stats and the sections in order. */
export function SpecSections({
  sessionId,
  spec,
  onSpec,
}: {
  sessionId: string;
  spec: LiveSpec;
  onSpec: (spec: LiveSpec) => void;
}): React.JSX.Element {
  const s = t.admin.requirements.spec;
  const context = Object.entries(spec.context);
  const mvp = spec.mvpChallenge;
  const mvpLabel = mvp.done
    ? s.mvpDone(mvp.asked.length)
    : mvp.started
      ? s.mvpInProgress(mvp.asked.length)
      : s.mvpNotStarted;

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-3 gap-3">
        <StatTile label={s.stats.fields} value={spec.stats.fields} />
        <StatTile label={s.stats.sectionsWithContent} value={spec.stats.sectionsWithContent} />
        <StatTile label={s.stats.openFindings} value={spec.stats.openFindings} />
      </div>

      <div className="grid gap-3 rounded-xl border p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{s.mvpTitle}</h3>
          <Badge variant={mvp.done ? "success" : mvp.started ? "warning" : "outline"}>{mvpLabel}</Badge>
        </div>
        {context.length > 0 ? (
          <>
            <h3 className="font-semibold">{s.contextTitle}</h3>
            <dl className="grid gap-2 sm:grid-cols-[max-content_1fr] sm:gap-x-4">
              {context.map(([key, value]) => (
                <React.Fragment key={key}>
                  <dt className="text-muted-foreground text-xs font-medium sm:pt-0.5">{humanize(key)}</dt>
                  <dd className="whitespace-pre-wrap">{value}</dd>
                </React.Fragment>
              ))}
            </dl>
          </>
        ) : null}
      </div>

      {spec.sections.length === 0 ? (
        <p className="text-muted-foreground text-sm">{s.noSections}</p>
      ) : (
        spec.sections.map((section) => (
          <SpecSectionCard key={section.key} sessionId={sessionId} section={section} onSpec={onSpec} />
        ))
      )}
    </div>
  );
}

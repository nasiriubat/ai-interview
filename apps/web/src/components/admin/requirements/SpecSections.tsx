"use client";

import * as React from "react";
import { DiagramsPanel } from "./DiagramsPanel";
import { SpecSectionCard } from "./SpecSectionCard";
import { StatTile } from "@/components/admin/StatTile";
import { EnumLabel } from "@/components/common/EnumLabel";
import { Badge } from "@/components/ui/badge";
import { t } from "@/i18n";
import type { LiveSpec } from "@/lib/api/schemas";

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
  // An empty "Diagrams" section card sat right above the diagrams panel, so the page showed two
  // "Diagrams" headings, one saying "Nothing captured yet" (simulation 2026-10-15). The panel is
  // where diagrams live; the section card shows only when it holds something.
  const sections = spec.sections.filter((x) => !(x.key === "diagrams" && x.status === "empty"));
  const mvp = spec.mvpChallenge;
  // The label says what happened, not just whether the walk started (D-322): an interview that is
  // over and never reached the walk is "skipped", not "not started".
  const mvpLabel =
    mvp.outcome === "off"
      ? s.mvpOff
      : mvp.outcome === "done"
        ? s.mvpDone(mvp.asked.length)
        : mvp.outcome === "in_progress"
          ? s.mvpInProgress(mvp.asked.length)
          : mvp.outcome === "skipped"
            ? mvp.endedBy === "finish"
              ? s.mvpSkippedFinish(mvp.asked.length)
              : s.mvpSkippedLimit(mvp.asked.length)
            : s.mvpNotStarted;
  const mvpVariant =
    mvp.outcome === "done" ? "success" : mvp.outcome === "in_progress" ? "warning" : "outline";

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-3 gap-3">
        <StatTile label={s.stats.fields} value={spec.stats.fields} />
        <StatTile label={s.stats.sectionsWithContent} value={spec.stats.sectionsWithContent} />
        <StatTile label={s.stats.openFindings} value={spec.stats.openFindings} />
      </div>

      <div className="grid gap-3 bg-card shadow-card rounded-lg p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{s.mvpTitle}</h3>
          <Badge variant={mvpVariant}>{mvpLabel}</Badge>
        </div>
        {context.length > 0 ? (
          <>
            <h3 className="font-semibold">{s.contextTitle}</h3>
            <dl className="grid gap-2 sm:grid-cols-[max-content_1fr] sm:gap-x-4">
              {context.map(([key, value]) => (
                <React.Fragment key={key}>
                  <dt className="text-muted-foreground text-xs font-medium sm:pt-0.5">
                    <EnumLabel kind="contextKey" value={key} />
                  </dt>
                  <dd className="whitespace-pre-wrap">{value}</dd>
                </React.Fragment>
              ))}
            </dl>
          </>
        ) : null}
      </div>

      {sections.length === 0 ? (
        <p className="text-muted-foreground text-sm">{s.noSections}</p>
      ) : (
        sections.map((section) => (
          <SpecSectionCard key={section.key} sessionId={sessionId} section={section} onSpec={onSpec} />
        ))
      )}

      <DiagramsPanel sessionId={sessionId} diagrams={spec.diagrams} onSpec={onSpec} />
    </div>
  );
}

"use client";

import type { FindingOutcome } from "@aidp/shared";
import * as React from "react";
import { EmptyState } from "@/components/admin/EmptyState";
import { Flash, useAction } from "@/components/admin/Flash";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { FindingRecord, LiveSpec } from "@/lib/api/schemas";
import { sectionTitle } from "@/lib/requirements/labels";

const OPEN = new Set(["open", "raised"]);

function location(f: FindingRecord): string {
  const title = sectionTitle(f.section, null);
  return f.path ? `${title} · ${f.path}` : title;
}

function FindingCard({
  sessionId,
  finding: f,
  onSpec,
}: {
  sessionId: string;
  finding: FindingRecord;
  onSpec: (spec: LiveSpec) => void;
}): React.JSX.Element {
  const s = t.admin.requirements.findings;
  const action = useAction();
  const [note, setNote] = React.useState("");
  const noteId = `finding-note-${f.id}`;

  const settle = (outcome: FindingOutcome): void => {
    void action.run(async () => {
      const trimmed = note.trim();
      onSpec(await staffClient.requirements.settleFinding(sessionId, f.id, outcome, trimmed || undefined));
    }, s.settled);
  };

  return (
    <article className="grid gap-3 bg-card shadow-card rounded-lg p-4 text-sm" aria-label={f.description}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{s.types[f.type]}</Badge>
        <StatusBadge status={f.status} />
        <span className="text-muted-foreground text-xs">{s.confidences[f.confidence]}</span>
        {f.pushedBack ? <span className="text-muted-foreground text-xs">· {s.pushedBack}</span> : null}
      </div>
      <p className="font-medium">{f.description}</p>
      <dl className="grid gap-2 sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        <dt className="text-muted-foreground text-xs font-medium">{s.location}</dt>
        <dd>{location(f)}</dd>
        <dt className="text-muted-foreground text-xs font-medium">{s.resolution}</dt>
        <dd>{f.resolution}</dd>
        <dt className="text-muted-foreground text-xs font-medium">{s.default}</dt>
        <dd>{f.default}</dd>
      </dl>
      <div className="grid gap-2">
        <label htmlFor={noteId} className="text-xs font-medium">
          {s.note} <span className="text-muted-foreground font-normal">({t.app.optional})</span>
        </label>
        <Textarea
          id={noteId}
          rows={2}
          value={note}
          placeholder={s.notePlaceholder}
          aria-label={s.noteLabel(f.description)}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
      </div>
      <div role="group" aria-label={s.actionsLabel(f.description)} className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={action.busy}
          onClick={() => {
            settle("resolved");
          }}
        >
          {s.resolve}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={action.busy}
          onClick={() => {
            settle("accepted");
          }}
        >
          {s.accept}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={action.busy}
          onClick={() => {
            settle("deferred");
          }}
        >
          {s.defer}
        </Button>
      </div>
      <Flash flash={action.flash} />
    </article>
  );
}

function SettledFinding({ finding: f }: { finding: FindingRecord }): React.JSX.Element {
  const s = t.admin.requirements.findings;
  return (
    <details className="bg-muted/50 rounded-lg px-4 py-2 text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <Badge variant="secondary">{s.types[f.type]}</Badge>
        <StatusBadge status={f.status} />
        <span className="min-w-0 flex-1 truncate">{f.description}</span>
      </summary>
      <dl className="mt-3 grid gap-2 sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        <dt className="text-muted-foreground text-xs font-medium">{s.location}</dt>
        <dd>{location(f)}</dd>
        <dt className="text-muted-foreground text-xs font-medium">{s.outcome}</dt>
        <dd>{s.statuses[f.status]}</dd>
        {f.note ? (
          <>
            <dt className="text-muted-foreground text-xs font-medium">{s.note}</dt>
            <dd className="whitespace-pre-wrap">{f.note}</dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}

/** The Findings tab: open and raised findings with their actions, settled ones collapsed. */
export function FindingsList({
  sessionId,
  findings,
  onSpec,
}: {
  sessionId: string;
  findings: FindingRecord[];
  onSpec: (spec: LiveSpec) => void;
}): React.JSX.Element {
  const s = t.admin.requirements.findings;
  const open = findings.filter((f) => OPEN.has(f.status));
  const settled = findings.filter((f) => !OPEN.has(f.status));
  if (findings.length === 0) return <EmptyState text={s.empty} />;
  return (
    <div className="grid gap-6">
      <section aria-label={s.openTitle} className="grid gap-3">
        <h3 className="text-sm font-semibold">
          {s.openTitle} ({open.length})
        </h3>
        {open.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t.admin.common.dash}</p>
        ) : (
          open.map((f) => <FindingCard key={f.id} sessionId={sessionId} finding={f} onSpec={onSpec} />)
        )}
      </section>
      {settled.length > 0 ? (
        <section aria-label={s.settledTitle} className="grid gap-2">
          <h3 className="text-sm font-semibold">
            {s.settledTitle} ({settled.length})
          </h3>
          {settled.map((f) => (
            <SettledFinding key={f.id} finding={f} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

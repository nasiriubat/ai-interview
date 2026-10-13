"use client";

import { PencilIcon } from "lucide-react";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { ReportMarkdown } from "@/components/report/ReportMarkdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import type { LiveSection, LiveSpec } from "@/lib/api/schemas";
import { sectionTitle } from "@/lib/requirements/labels";

const STATUS_VARIANT = { empty: "outline", draft: "secondary", edited: "success" } as const;

/** One live-spec section: rendered Markdown with an inline editor. Owner edits are authoritative (FR-23). */
export function SpecSectionCard({
  sessionId,
  section,
  onSpec,
}: {
  sessionId: string;
  section: LiveSection;
  onSpec: (spec: LiveSpec) => void;
}): React.JSX.Element {
  const s = t.admin.requirements.spec;
  const action = useAction();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(section.markdown);
  const title = sectionTitle(section.key, section.title);
  const headingId = `spec-section-${section.key}`;
  const editorId = `spec-editor-${section.key}`;

  const startEdit = (): void => {
    setDraft(section.markdown);
    setEditing(true);
  };
  const save = (markdown: string, success: string): void => {
    void action
      .run(async () => {
        onSpec(await staffClient.requirements.editSection(sessionId, section.key, markdown));
      }, success)
      .then((ok) => {
        if (ok) setEditing(false);
      });
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-3 bg-card shadow-card rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={headingId} className="text-sm font-semibold">
            {title}
          </h3>
          <Badge variant={STATUS_VARIANT[section.status]}>
            {section.status === "edited" ? s.editedByOwner : s.sectionStatus[section.status]}
          </Badge>
        </div>
        {!editing ? (
          <Button size="sm" variant="ghost" onClick={startEdit} aria-label={s.editLabel(title)}>
            <PencilIcon /> {s.edit}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save(draft, s.saved);
          }}
        >
          <label htmlFor={editorId} className="sr-only">
            {s.editorLabel(title)}
          </label>
          <Textarea
            id={editorId}
            value={draft}
            rows={10}
            aria-describedby={`${editorId}-hint`}
            className="font-mono text-xs"
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <p id={`${editorId}-hint`} className="text-muted-foreground text-xs">
            {s.editorHint}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={action.busy}>
              {action.busy ? t.app.saving : s.save}
            </Button>
            {section.status === "edited" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={action.busy}
                onClick={() => {
                  save("", s.cleared);
                }}
              >
                {s.clearEdit}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={action.busy}
              onClick={() => {
                setEditing(false);
              }}
            >
              {t.app.cancel}
            </Button>
          </div>
        </form>
      ) : section.markdown.trim() ? (
        <ReportMarkdown markdown={section.markdown} />
      ) : (
        <p className="text-muted-foreground text-sm">{s.emptySection}</p>
      )}
      <Flash flash={action.flash} />
    </section>
  );
}

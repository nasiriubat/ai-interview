"use client";

import { AlertTriangleIcon, PencilIcon, PlusIcon } from "lucide-react";
import * as React from "react";
import { Flash, useAction } from "@/components/admin/Flash";
import { Field, SelectField, TextField, describedBy } from "@/components/admin/forms";
import { MermaidDiagram } from "@/components/report/MermaidDiagram";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { isApiError } from "@/lib/api/errors";
import type { LiveDiagram, LiveSpec } from "@/lib/api/schemas";

const TYPES = ["context", "containers", "sequence", "state", "entity"] as const;
type DiagramType = (typeof TYPES)[number];
const STATUS_VARIANT = { generated: "secondary", edited: "success", added: "success" } as const;

/** Server answer for a refused diagram: `details.issues` is a list of `{ message, line? }`. */
function issuesOf(e: unknown): { message: string; line?: number }[] {
  if (!isApiError(e) || typeof e.details !== "object" || e.details === null) return [];
  const raw = (e.details as { issues?: unknown }).issues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((i: unknown) => {
    if (typeof i !== "object" || i === null) return [];
    const { message, line } = i as { message?: unknown; line?: unknown };
    return typeof message === "string" ? [{ message, ...(typeof line === "number" ? { line } : {}) }] : [];
  });
}

/** The value, a beat after it stops changing: the preview redraws on pauses, not on keystrokes. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}

interface Draft {
  title: string;
  type: DiagramType;
  description: string;
  mermaid: string;
}

function DiagramForm({
  sessionId,
  diagramKey,
  initial,
  original,
  status,
  onSpec,
  onClose,
}: {
  sessionId: string;
  /** `null` adds a diagram. */
  diagramKey: string | null;
  initial: Draft;
  original?: string | undefined;
  status?: LiveDiagram["status"] | undefined;
  onSpec: (spec: LiveSpec) => void;
  onClose: () => void;
}): React.JSX.Element {
  const s = t.admin.requirements.spec.diagrams;
  const id = React.useId();
  const action = useAction();
  const [draft, setDraft] = React.useState<Draft>(initial);
  const [errors, setErrors] = React.useState<{ description?: string; mermaid?: string }>({});
  const [issues, setIssues] = React.useState<{ message: string; line?: number }[]>([]);
  const preview = useDebounced(draft.mermaid, 800);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = (): void => {
    const next = {
      ...(draft.description.trim() === "" ? { description: s.descriptionRequired } : {}),
      ...(draft.mermaid.trim() === "" ? { mermaid: s.sourceRequired } : {}),
    };
    setErrors(next);
    setIssues([]);
    if (Object.keys(next).length > 0) return;
    void (async () => {
      const outcome = { verified: true };
      const ok = await action.run(async () => {
        try {
          const result = await staffClient.requirements.diagrams.save(sessionId, diagramKey, {
            mermaid: draft.mermaid,
            description: draft.description.trim(),
            ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
            type: draft.type,
          });
          outcome.verified = result.verified;
          onSpec(result.spec);
        } catch (e) {
          setIssues(issuesOf(e));
          throw e;
        }
      });
      if (ok) {
        if (outcome.verified) toast.success(s.saved);
        else toast.warning(s.savedUnverified);
        onClose();
      }
    })();
  };

  const reset = (): void => {
    if (diagramKey === null) return;
    void action
      .run(
        async () => {
          onSpec(await staffClient.requirements.diagrams.reset(sessionId, diagramKey));
        },
        status === "added" ? s.removeDone : s.resetDone,
      )
      .then((ok) => {
        if (ok) onClose();
      });
  };

  const sourceId = `${id}-source`;
  return (
    <form
      className="grid gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <TextField
        id={`${id}-title`}
        label={s.titleLabel}
        value={draft.title}
        onChange={(v) => {
          set("title", v);
        }}
      />
      <SelectField<DiagramType>
        id={`${id}-type`}
        label={s.typeLabel}
        value={draft.type}
        onChange={(v) => {
          set("type", v);
        }}
        options={TYPES.map((value) => ({ value, label: s.types[value] }))}
      />
      <Field
        id={`${id}-description`}
        label={s.descriptionLabel}
        hint={s.descriptionHint}
        error={errors.description}
        required
      >
        <Textarea
          id={`${id}-description`}
          rows={2}
          value={draft.description}
          required
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={describedBy(`${id}-description`, s.descriptionHint, errors.description)}
          onChange={(e) => {
            set("description", e.target.value);
          }}
        />
      </Field>
      <div className="grid gap-3 lg:grid-cols-2">
        <Field id={sourceId} label={s.sourceLabel} hint={s.sourceHint} error={errors.mermaid} required>
          <Textarea
            id={sourceId}
            rows={12}
            value={draft.mermaid}
            spellCheck={false}
            required
            className="font-mono text-xs"
            aria-invalid={errors.mermaid ? true : undefined}
            aria-describedby={describedBy(sourceId, s.sourceHint, errors.mermaid)}
            onChange={(e) => {
              set("mermaid", e.target.value);
            }}
          />
        </Field>
        <div className="grid content-start gap-1.5">
          <p className="text-sm font-medium">{s.previewTitle}</p>
          <div className="bg-card min-h-24 rounded-md border p-2">
            {preview.trim() ? (
              <MermaidDiagram code={preview} label={s.previewLabel(draft.title || draft.description)} />
            ) : (
              <p className="text-muted-foreground p-2 text-sm">{s.previewEmpty}</p>
            )}
          </div>
        </div>
      </div>

      {issues.length > 0 ? (
        <Alert variant="destructive">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertDescription>
            <p className="font-medium">{s.issuesTitle}</p>
            <ul className="list-disc pl-5">
              {issues.map((issue, i) => (
                <li key={`${i}-${issue.message}`}>
                  {issue.line !== undefined ? `${s.line(issue.line)}: ` : ""}
                  {issue.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <Flash flash={action.flash} />
      )}

      {original !== undefined && status === "edited" ? (
        <details className="text-xs">
          <summary className="cursor-pointer">{s.showOriginal}</summary>
          <pre className="mt-1 overflow-x-auto rounded border p-2" aria-label={s.original}>
            {original}
          </pre>
        </details>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={action.busy}>
          {action.busy ? t.app.saving : s.save}
        </Button>
        {diagramKey !== null && status !== "generated" ? (
          <Button type="button" size="sm" variant="outline" disabled={action.busy} onClick={reset}>
            {status === "added" ? s.remove : s.reset}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" disabled={action.busy} onClick={onClose}>
          {t.app.cancel}
        </Button>
      </div>
    </form>
  );
}

function DiagramCard({
  sessionId,
  diagram,
  onSpec,
}: {
  sessionId: string;
  diagram: LiveDiagram;
  onSpec: (spec: LiveSpec) => void;
}): React.JSX.Element {
  const s = t.admin.requirements.spec.diagrams;
  const [editing, setEditing] = React.useState(false);
  const headingId = `diagram-${diagram.key}`;
  return (
    <section aria-labelledby={headingId} className="grid gap-3 bg-card shadow-card rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id={headingId} className="text-sm font-semibold">
            {diagram.title}
          </h4>
          <Badge variant={STATUS_VARIANT[diagram.status]}>{s.status[diagram.status]}</Badge>
        </div>
        {!editing ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={s.edit(diagram.title)}
            onClick={() => {
              setEditing(true);
            }}
          >
            <PencilIcon /> {t.admin.requirements.spec.edit}
          </Button>
        ) : null}
      </div>
      {diagram.status !== "generated" && !diagram.verified ? (
        <Alert variant="warning" role="status">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertDescription>{s.unverified}</AlertDescription>
        </Alert>
      ) : null}
      {editing ? (
        <DiagramForm
          sessionId={sessionId}
          diagramKey={diagram.key}
          initial={{
            title: diagram.title,
            type: diagram.type,
            description: diagram.description,
            mermaid: diagram.mermaid,
          }}
          original={diagram.original}
          status={diagram.status}
          onSpec={onSpec}
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : (
        <figure className="grid gap-2">
          <MermaidDiagram code={diagram.mermaid} label={diagram.description || diagram.title} />
          {diagram.description ? (
            <figcaption className="text-muted-foreground text-xs">{diagram.description}</figcaption>
          ) : null}
        </figure>
      )}
    </section>
  );
}

/**
 * The diagrams of the specification as editable sections (FR-23): Mermaid source with a live
 * preview, a caption that is also the alt text, and the owner's text kept across regeneration.
 */
export function DiagramsPanel({
  sessionId,
  diagrams,
  onSpec,
}: {
  sessionId: string;
  diagrams: readonly LiveDiagram[];
  onSpec: (spec: LiveSpec) => void;
}): React.JSX.Element {
  const s = t.admin.requirements.spec.diagrams;
  const [adding, setAdding] = React.useState(false);
  return (
    <section aria-labelledby="spec-diagrams" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="spec-diagrams" className="text-sm font-semibold">
          {s.title}
        </h3>
        {!adding ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAdding(true);
            }}
          >
            <PlusIcon /> {s.add}
          </Button>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">{s.intro}</p>
      {adding ? (
        <div className="bg-card shadow-card rounded-lg p-4">
          <DiagramForm
            sessionId={sessionId}
            diagramKey={null}
            initial={{ title: "", type: "context", description: "", mermaid: "flowchart LR\n  A --> B" }}
            onSpec={onSpec}
            onClose={() => {
              setAdding(false);
            }}
          />
        </div>
      ) : null}
      {diagrams.length === 0 && !adding ? (
        <p className="text-muted-foreground text-sm">{s.none}</p>
      ) : (
        diagrams.map((d) => <DiagramCard key={d.key} sessionId={sessionId} diagram={d} onSpec={onSpec} />)
      )}
    </section>
  );
}

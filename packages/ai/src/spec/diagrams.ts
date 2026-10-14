import type { LiveDiagram, SpecDiagram, SpecEdits } from "@aidp/shared";

/*
 * Diagrams as editable sections (FR-23, D-214).
 *
 * The generator proposes diagrams; the owner may rewrite one, add one, or put one back. All three
 * are entries in the session's `specEdits` under `diagram:<key>`, which is what makes them
 * authoritative across regeneration: the generator never sees them, and `mergeDiagrams` applies
 * them to whatever it drew. Nothing here calls a renderer; the Mermaid source is checked
 * statically and the renderer is asked to parse it by the service that saves it.
 */

export const DIAGRAM_EDIT_PREFIX = "diagram:";
/** Largest Mermaid source accepted, in UTF-8 bytes. Kroki rejects far less than this is useful. */
export const MAX_DIAGRAM_BYTES = 20_000;
/** Most diagrams one specification carries, generated and added together. */
export const MAX_DIAGRAMS = 30;
/** A diagram key: what the owner chooses for a diagram they add, and what the generator uses. */
export const DIAGRAM_KEY = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export const diagramEditKey = (key: string): string => `${DIAGRAM_EDIT_PREFIX}${key}`;
export const isDiagramEditKey = (editKey: string): boolean => editKey.startsWith(DIAGRAM_EDIT_PREFIX);
export const diagramKeyOf = (editKey: string): string => editKey.slice(DIAGRAM_EDIT_PREFIX.length);

const DIAGRAM_START =
  /^(flowchart(?:-elk)?|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|sankey-beta|xychart-beta|block-beta|architecture-beta|packet-beta|kanban)\b/;

/** Tags Mermaid labels use for line breaks and emphasis; anything else is refused. */
const SAFE_TAG = /<\/?(?:br|b|i|u|em|strong|sub|sup|small)\s*\/?>/gi;

export interface DiagramIssue {
  code:
    | "empty"
    | "too_large"
    | "control_characters"
    | "unknown_type"
    | "front_matter"
    | "directive"
    | "html"
    | "script"
    | "remote_resource"
    | "click";
  message: string;
  /** 1-based line the problem is on, when it is on one. */
  line?: number;
}

export type DiagramCheck = { ok: true; source: string } | { ok: false; issues: DiagramIssue[] };

/**
 * Static checks on Mermaid source from a person. They exist because the source is rendered by a
 * headless browser inside the renderer service: a label that is an `<img>` makes that browser
 * fetch a URL, and a `click` statement or an `init` directive changes what the renderer is
 * willing to do. The renderer's own parser still decides whether the diagram is valid.
 */
export function checkMermaidSource(raw: string): DiagramCheck {
  const source = raw.replace(/\r\n?/g, "\n").trim();
  const issues: DiagramIssue[] = [];
  if (source === "") return { ok: false, issues: [{ code: "empty", message: "The diagram is empty." }] };
  if (Buffer.byteLength(source, "utf8") > MAX_DIAGRAM_BYTES)
    return {
      ok: false,
      issues: [
        {
          code: "too_large",
          message: `The diagram is over ${MAX_DIAGRAM_BYTES / 1000} KB; split it into two diagrams.`,
        },
      ],
    };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source))
    return {
      ok: false,
      issues: [{ code: "control_characters", message: "The diagram contains control characters." }],
    };

  const lines = source.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "" && !/^\s*%%(?!\{)/.test(l));
  const head = (lines[first] ?? "").trim();
  if (head === "---")
    issues.push({
      code: "front_matter",
      message: "Remove the front matter block; the theme is set by the export.",
      line: first + 1,
    });
  else if (!DIAGRAM_START.test(head))
    issues.push({
      code: "unknown_type",
      message: "The first line must name a Mermaid diagram type, such as flowchart LR or sequenceDiagram.",
      line: first + 1,
    });

  lines.forEach((text, i) => {
    const line = i + 1;
    if (/%%\{/.test(text))
      issues.push({ code: "directive", message: "Directives (%%{ }%%) are not allowed.", line });
    if (/^\s*click\s/i.test(text))
      issues.push({ code: "click", message: "click statements are not allowed.", line });
    if (/javascript\s*:|data\s*:\s*text\/html/i.test(text))
      issues.push({ code: "script", message: "Script URLs are not allowed.", line });
    if (/url\s*\(|@import|@\{|https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(text))
      issues.push({
        code: "remote_resource",
        message: "Links and remote resources are not allowed in a diagram.",
        line,
      });
    // `<<done>>` is a sequence-diagram label, not a tag: a `<` that follows another is not a start.
    if (/(?<!<)<[a-z/!?]/i.test(text.replace(SAFE_TAG, "")))
      issues.push({ code: "html", message: "HTML in labels is not allowed, except <br>.", line });
  });
  return issues.length ? { ok: false, issues } : { ok: true, source };
}

/**
 * The generated diagrams with the owner's edits applied: an edit replaces the source of the diagram
 * with its key, and an entry with no generated twin is a diagram the owner added (appended, in the
 * order they were added). Edits survive regeneration because this runs on every document, and it is
 * idempotent: a document that already carries an edit is merged again without drift, and an edit
 * that has been removed puts back what the generator drew.
 */
export function mergeDiagrams(generated: readonly SpecDiagram[], edits: SpecEdits): SpecDiagram[] {
  const out: SpecDiagram[] = [];
  for (const g of generated) {
    const edit = edits[diagramEditKey(g.key)];
    const live = edit?.mermaid?.trim() ? edit : undefined;
    if (g.source === "added") {
      // An addition whose edit has been removed is no longer part of the document.
      if (live) out.push({ ...applyEdit(g, live), source: "added" });
      continue;
    }
    const { original, ...rest } = g;
    const drawn: SpecDiagram =
      g.source === "edited" && original !== undefined
        ? { ...rest, mermaid: original, source: "generated" }
        : rest;
    out.push(live ? { ...applyEdit(drawn, live), source: "edited", original: drawn.mermaid } : drawn);
  }
  const known = new Set(generated.map((d) => d.key));
  for (const [editKey, edit] of Object.entries(edits)) {
    if (!isDiagramEditKey(editKey) || !edit.mermaid?.trim()) continue;
    const key = diagramKeyOf(editKey);
    if (known.has(key)) continue;
    out.push({
      key,
      title: edit.title?.trim() || key,
      type: edit.type ?? "context",
      mermaid: edit.mermaid,
      ...(edit.description?.trim() ? { description: edit.description.trim() } : {}),
      source: "added",
    });
  }
  return out.slice(0, MAX_DIAGRAMS);
}

function applyEdit(base: SpecDiagram, edit: SpecEdits[string]): SpecDiagram {
  return {
    ...base,
    mermaid: edit.mermaid ?? base.mermaid,
    title: edit.title?.trim() || base.title,
    type: edit.type ?? base.type,
    ...(edit.description?.trim() ? { description: edit.description.trim() } : {}),
  };
}

/** What the live spec shows the owner: the merged diagrams with where each came from. */
export function liveDiagrams(generated: readonly SpecDiagram[], edits: SpecEdits): LiveDiagram[] {
  return mergeDiagrams(generated, edits).map((d) => {
    const edit = edits[diagramEditKey(d.key)];
    return {
      key: d.key,
      title: d.title,
      type: d.type,
      mermaid: d.mermaid,
      description: d.description ?? "",
      status: d.source ?? "generated",
      // An edit saved while the renderer was down says so; generated diagrams are the model's own.
      verified: edit ? Boolean(edit.validatedAt) : true,
      ...(d.original !== undefined ? { original: d.original } : {}),
    };
  });
}

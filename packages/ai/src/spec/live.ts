import {
  normalizeSectionKey,
  SPEC_SECTION_KEYS,
  SPEC_SECTION_TITLES,
  type Fact,
  type LiveSection,
  type LiveSpec,
  type Path,
  type SessionState,
  type SpecDiagram,
  type SpecEdits,
} from "@aidp/shared";
import { isDiagramEditKey, liveDiagrams } from "./diagrams.js";

export type SpecFieldFact = Extract<Fact, { kind: "spec_field" }>;

/** The spec_field facts in state, with their section normalized to a canonical key where possible. */
export function specFacts(state: SessionState): (SpecFieldFact & { sectionKey: string })[] {
  return state.facts
    .filter((f): f is SpecFieldFact => f.kind === "spec_field")
    .map((f) => ({ ...f, sectionKey: normalizeSectionKey(f.section) ?? f.section }));
}

export interface MvpItem {
  path: string;
  title: string;
  value: Record<string, unknown>;
}

/** Functional requirements: object-valued fields in the functional section (a plain note is not a requirement). */
export function requirementFacts(state: SessionState): (SpecFieldFact & { sectionKey: string })[] {
  return specFacts(state).filter(
    (f) =>
      f.sectionKey === "functional" &&
      f.value !== null &&
      typeof f.value === "object" &&
      !Array.isArray(f.value),
  );
}

/** Functional requirements tagged mvp (default when untagged) in the order they were recorded. */
export function mvpItems(state: SessionState): MvpItem[] {
  return requirementFacts(state)
    .map((f) => ({ path: f.path, value: asObject(f.value), title: titleOf(f.value, f.path) }))
    .filter((i) => scopeOf(i.value) === "mvp");
}

/** The next MVP item the challenge has not asked about yet. */
export function nextMvpItem(state: SessionState): MvpItem | undefined {
  const asked = new Set(state.mvpChallenge.asked);
  return mvpItems(state).find((i) => !asked.has(i.path));
}

export function scopeOf(value: unknown): "mvp" | "future" {
  const v = asObject(value);
  if (v.scope === "future" || v.mvp === false || v.future === true) return "future";
  return "mvp";
}

export function titleOf(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  const v = asObject(value);
  for (const k of ["title", "name", "summary", "choice", "role"]) {
    const t = v[k];
    if (typeof t === "string" && t.trim()) return t;
  }
  return fallback;
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Humanized title for a section key the catalog does not know. */
export function sectionTitle(key: string): string {
  const known = (SPEC_SECTION_TITLES as Record<string, string | undefined>)[key];
  return known ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Renders one value as markdown: strings verbatim, arrays as lists, objects as `key: value` pairs. */
export function renderValue(value: unknown, indent = ""): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null)) return value.map(String).join(", ");
    return value.map((v) => `\n${indent}  - ${renderValue(v, `${indent}  `)}`).join("");
  }
  const o = value as Record<string, unknown>;
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      const r = renderValue(v, `${indent}  `);
      return r.startsWith("\n") ? `${k}:${r}` : `${k}: ${r}`;
    })
    .join("; ");
}

function renderFunctional(fields: { path: string; value: unknown; source: string }[]): string {
  return fields
    .map((f) => {
      const v = asObject(f.value);
      const title = titleOf(f.value, f.path);
      const scope = scopeOf(f.value);
      const acceptance = Array.isArray(v.acceptance) ? v.acceptance.map(String) : [];
      const lines = [`- **${f.path}** (${scope}): ${title}`];
      if (typeof v.description === "string" && v.description && v.description !== title)
        lines.push(`  ${v.description}`);
      for (const a of acceptance) lines.push(`  - Acceptance: ${a}`);
      if (typeof v.reason === "string" && v.reason) lines.push(`  - Reason: ${v.reason}`);
      return lines.join("\n");
    })
    .join("\n");
}

function renderFields(fields: { path: string; value: unknown; source: string }[]): string {
  return fields
    .map((f) => {
      const r = renderValue(f.value);
      const mark =
        f.source === "recommended" ? " _(recommended)_" : f.source === "handoff" ? " _(from discovery)_" : "";
      return r.startsWith("\n") ? `- **${f.path}**${mark}:${r}` : `- **${f.path}**${mark}: ${r}`;
    })
    .join("\n");
}

export interface LiveSpecInput {
  title: string;
  path: Path | null | undefined;
  state: SessionState;
  edits: SpecEdits;
  /** Section keys in order; unknown keys found in facts are appended. */
  sections?: readonly string[];
  /** The newest version's diagrams, which the owner's diagram edits are laid over (FR-23). */
  diagrams?: readonly SpecDiagram[];
}

/** Layer 2 of a requirements session made visible: the spec as it stands after the last turn (FR-22). */
export function renderLiveSpec(input: LiveSpecInput): LiveSpec {
  const facts = specFacts(input.state);
  const order = [...(input.sections ?? SPEC_SECTION_KEYS)];
  for (const f of facts) if (!order.includes(f.sectionKey)) order.push(f.sectionKey);
  // Diagram edits share the column but are not sections: they are shown, and applied, as diagrams.
  for (const k of Object.keys(input.edits)) if (!isDiagramEditKey(k) && !order.includes(k)) order.push(k);

  const sections: LiveSection[] = order.map((key) => {
    const fields = facts
      .filter((f) => f.sectionKey === key)
      .map((f) => ({ path: f.path, value: f.value, source: f.source }));
    const edit = input.edits[key];
    if (edit?.markdown.trim()) {
      return { key, title: sectionTitle(key), status: "edited", markdown: edit.markdown, fields };
    }
    const markdown = key === "functional" ? renderFunctional(fields) : renderFields(fields);
    return { key, title: sectionTitle(key), status: fields.length ? "draft" : "empty", markdown, fields };
  });

  return {
    title: input.title,
    path: input.path ?? null,
    context: input.state.contextAnswers,
    sections,
    diagrams: liveDiagrams(input.diagrams ?? [], input.edits),
    findings: input.state.findings,
    decisions: input.state.decisions,
    mvpChallenge: input.state.mvpChallenge,
    stats: {
      fields: facts.length,
      sectionsWithContent: sections.filter((s) => s.status !== "empty").length,
      openFindings: input.state.findings.filter((f) => f.status === "open" || f.status === "raised").length,
    },
  };
}

/** Compact text of the spec state for prompts (issue detection, generation): never the transcript. */
export function renderSpecState(state: SessionState, path?: Path, edits: SpecEdits = {}): string {
  const live = renderLiveSpec({ title: "", path: path ?? null, state, edits });
  const lines: string[] = [];
  if (path) lines.push(`Path: ${path}`);
  if (Object.keys(state.contextAnswers).length) {
    lines.push("Context block:");
    for (const [k, v] of Object.entries(state.contextAnswers)) lines.push(`- ${k}: ${v}`);
  }
  if (state.decisions.length) {
    lines.push("Decisions:");
    for (const d of state.decisions) lines.push(`- ${d.key}: ${d.choice} (${d.source})`);
  }
  for (const s of live.sections) {
    if (s.status === "empty") continue;
    lines.push(
      `## ${s.key}: ${s.title}${s.status === "edited" ? " (edited by the owner; authoritative)" : ""}`,
    );
    lines.push(s.markdown);
  }
  const settled = state.findings.filter((f) => f.status !== "open" && f.status !== "raised");
  if (settled.length) {
    lines.push("Findings already settled (do not raise again):");
    for (const f of settled)
      lines.push(`- [${f.type}] ${f.section}${f.path ? `/${f.path}` : ""}: ${f.description} → ${f.status}`);
  }
  return lines.join("\n");
}

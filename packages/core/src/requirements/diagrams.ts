import { DIAGRAM_KEY, diagramEditKey, isDiagramEditKey, MAX_DIAGRAMS, mergeDiagrams } from "@aidp/ai";
import type { DiagramType, LiveSpec, SpecEdits } from "@aidp/shared";
import type { RequirementsContext } from "./context.js";
import {
  DiagramInvalidError,
  DiagramLimitError,
  DiagramNotFoundError,
  PdfNotAvailableError,
} from "./errors.js";
import { nonEmpty, parseEdits, slug } from "./helpers.js";
import type { RequirementsServiceDeps, Viewer } from "./types.js";

export interface DiagramInput {
  mermaid: string;
  /** Caption and alt text. Required: a diagram nobody can read without seeing it is not finished. */
  description: string;
  title?: string | undefined;
  type?: DiagramType | undefined;
}

/**
 * Diagrams the owner edits or adds (FR-23, D-214). The edit is a `specEdits` entry under
 * `diagram:<key>`, which is what the generator's output is laid over on every regeneration, so an
 * edit is authoritative without the generator, or its prompt, knowing about it.
 */
export class RequirementsDiagrams {
  constructor(private readonly cx: RequirementsContext) {}

  private get deps(): RequirementsServiceDeps {
    return this.cx.deps;
  }

  /** Edits an existing diagram, or adds one when `key` names none. Returns the live spec. */
  async save(
    companyId: string,
    id: string,
    key: string | null,
    input: DiagramInput,
    userId: string,
    viewer: Viewer,
  ): Promise<{ spec: LiveSpec; key: string; verified: boolean }> {
    const exporter = this.deps.exporter;
    if (!exporter) throw new PdfNotAvailableError();
    const row = await this.cx.load(companyId, id, viewer);
    const edits = parseEdits(row.specEdits);
    const generated = await this.cx.generatedDiagrams(row.id);
    const existing = mergeDiagrams(generated, edits);

    const checked = await exporter.checkDiagram(input.mermaid);
    if (!checked.ok) throw new DiagramInvalidError(checked.issues);
    const source = checked.source ?? input.mermaid.trim();

    let target = key;
    if (target === null) {
      if (existing.length >= MAX_DIAGRAMS) throw new DiagramLimitError(MAX_DIAGRAMS);
      target = uniqueKey(`custom-${slug(input.title ?? "diagram")}`, new Set(existing.map((d) => d.key)));
    } else if (!existing.some((d) => d.key === target)) {
      throw new DiagramNotFoundError(target);
    }
    const base = existing.find((d) => d.key === target);
    const now = new Date().toISOString();
    const next: SpecEdits = {
      ...edits,
      [diagramEditKey(target)]: {
        markdown: "",
        mermaid: source,
        description: input.description.trim(),
        title: nonEmpty(input.title) ?? base?.title ?? target,
        type: input.type ?? base?.type ?? "context",
        validatedAt: checked.verified ? now : null,
        editedAt: now,
        editedBy: userId,
      },
    };
    await this.deps.db.session.update({ where: { id: row.id }, data: { specEdits: next } });
    await this.cx.appendEvent(row.id, "spec_edit", {
      kind: "diagram",
      key: target,
      chars: source.length,
      verified: checked.verified,
    });
    return {
      spec: await this.cx.liveSpecOf({ ...row, specEdits: next }),
      key: target,
      verified: checked.verified,
    };
  }

  /** Puts a generated diagram back, or removes one the owner added. */
  async reset(companyId: string, id: string, key: string, viewer: Viewer): Promise<LiveSpec> {
    const row = await this.cx.load(companyId, id, viewer);
    const edits = parseEdits(row.specEdits);
    const editKey = diagramEditKey(key);
    if (!isDiagramEditKey(editKey) || !edits[editKey]) throw new DiagramNotFoundError(key);
    const { [editKey]: _removed, ...rest } = edits;
    await this.deps.db.session.update({ where: { id: row.id }, data: { specEdits: rest } });
    await this.cx.appendEvent(row.id, "spec_edit", { kind: "diagram_reset", key });
    return this.cx.liveSpecOf({ ...row, specEdits: rest });
  }
}

function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  const clean = DIAGRAM_KEY.test(base) ? base : `custom-diagram`;
  const root = clean.slice(0, 40);
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

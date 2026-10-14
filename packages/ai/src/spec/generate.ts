import { createHash } from "node:crypto";
import {
  SpecDocumentSchema,
  SpecDiagramSchema,
  SpecPhaseSchema,
  SpecRequirementSchema,
  type AgentBundle,
  type BundleFormat,
  type DiagramType,
  type Finding,
  type Handoff,
  type Path,
  type SessionState,
  type SpecDocument,
  type SpecEdits,
  type SpecVersionStats,
} from "@aidp/shared";
import { z } from "zod";
import type { ModelCallerPort } from "../callModel.js";
import type { Logger } from "../engine/ports.js";
import { promptVersionTag, type PromptSource } from "../engine/prompts/index.js";
import { languageName } from "../util/language.js";
import { newNonce, wrapUntrusted } from "../util/untrusted.js";
import { renderBundle } from "./bundle.js";
import { mergeDiagrams } from "./diagrams.js";
import {
  asObject,
  renderLiveSpec,
  renderSpecState,
  requirementFacts,
  scopeOf,
  sectionTitle,
  titleOf,
} from "./live.js";
import { renderSpecMarkdown } from "./markdown.js";
import { judgeCandidatePairs } from "./merge.js";
import {
  curateRequirements,
  reqViewOf,
  requirementSimilarity,
  type CurationReport,
  type DuplicateThresholds,
  type ReqView,
} from "./quality.js";

/** What the model returns; the document is assembled from it plus the owner's edits. */
export const SpecGenerationOutputSchema = z.object({
  title: z.string().default(""),
  sections: z.array(z.object({ key: z.string(), markdown: z.string().default("") })).default([]),
  requirements: z.array(SpecRequirementSchema).default([]),
  phases: z.array(SpecPhaseSchema).default([]),
  openQuestions: z
    .array(z.object({ question: z.string(), defaultTaken: z.string().default("") }))
    .default([]),
  mvp: z
    .object({
      in: z.array(z.string()).default([]),
      movedOut: z.array(z.object({ id: z.string(), reason: z.string().default("") })).default([]),
      next: z.array(z.string()).default([]),
    })
    .prefault({}),
  diagrams: z.array(SpecDiagramSchema).default([]),
});

export interface SpecGenerationDeps {
  caller: ModelCallerPort;
  prompts: PromptSource;
  logger: Logger;
  now?: () => Date;
}

export interface SpecGenerationInput {
  companyId: string;
  sessionId: string;
  title: string;
  language: string;
  path?: Path;
  state: SessionState;
  summary: string;
  edits: SpecEdits;
  handoff?: Handoff;
  /** Section keys to produce, in order (setting `requirements.specSections`). */
  sections: readonly string[];
  diagramTypes: readonly DiagramType[];
  bundleFormat: BundleFormat;
  /**
   * Fewest functional requirements a version may have (template `completeness.minRequirements`).
   * A version with fewer is returned with `failure` set instead of being passed off as a
   * specification (D-191).
   */
  minRequirements?: number;
}

export type ReadBackStatus = "confirmed" | "unanswered" | "never";

/** The question an unconfirmed list adds, so a reader of the specification knows it was never reviewed. */
export const UNREVIEWED_LIST_QUESTION =
  "The participant did not review the requirement list: the interview ended before it was read back and confirmed. Is anything on it wrong or missing?";

/** Reads the state's record of the confirmation read-back (D-244). */
export function readBackStatus(
  state: Pick<SessionState, "findings" | "requirementsConfirmAsked">,
): ReadBackStatus {
  if (!state.requirementsConfirmAsked) return "never";
  const f = state.findings.find((x) => x.description.startsWith("Requirements confirmation."));
  if (!f) return "never";
  return f.status === "open" || f.status === "raised" ? "unanswered" : "confirmed";
}

export interface SpecGenerationResult {
  document: SpecDocument;
  markdown: string;
  bundle: AgentBundle;
  /** Findings still open when the version was generated. */
  issues: Finding[];
  stats: SpecVersionStats;
  generated: "model" | "fallback";
  /** What the quality pass did to the recorded requirements before the version was written (D-241). */
  curation: CurationReport;
  /**
   * Whether the owner heard the list (D-290): `confirmed` (read back and answered), `unanswered`
   * (read back, the participant left before answering), `never` (the interview ended without it).
   */
  readBack: ReadBackStatus;
  error?: string;
  /**
   * Set when the version must not be offered as a specification: fewer requirements than the
   * template's minimum. The caller stores the document and marks the version failed with this reason.
   */
  failure?: string;
}

/**
 * How alike a model-added requirement and a recorded one must be for the first to be folded into
 * the second. Higher than the merge pass's candidate threshold: a model-added item has no model
 * verdict behind it, and "Edit a note" is not a restatement of "Enter a note once".
 */
const RESTATEMENT_THRESHOLD = 0.6;

const reqView = (r: SpecDocument["requirements"][number]): ReqView => ({
  id: r.id,
  title: r.title,
  scope: r.scope,
  acceptance: r.acceptance,
});

/**
 * The requirements of a version: every one the interview recorded (the owner's scope and reason are
 * authoritative), improved by the model's wording where it wrote one, plus any the model added. A
 * version can never hold fewer requirements than the interview recorded (D-191).
 */
export function mergeRequirements(
  fromModel: SpecDocument["requirements"],
  fromState: SpecDocument["requirements"],
): SpecDocument["requirements"] {
  const model = new Map(fromModel.map((r) => [r.id.toUpperCase(), r]));
  const seen = new Set<string>();
  const out: SpecDocument["requirements"] = [];
  for (const s of fromState) {
    const key = s.id.toUpperCase();
    seen.add(key);
    const m = model.get(key);
    out.push(
      m
        ? {
            ...m,
            id: s.id,
            scope: s.scope,
            ...(s.reason ? { reason: s.reason } : {}),
            acceptance: m.acceptance.length ? m.acceptance : s.acceptance,
            // What the quality pass learned about it is the state's, whatever the model echoes.
            ...(s.evidence ? { evidence: s.evidence } : {}),
            ...(s.needsConfirmation ? { needsConfirmation: true } : {}),
            ...(s.mergedFrom?.length ? { mergedFrom: s.mergedFrom } : {}),
          }
        : s,
    );
  }
  // A requirement the model added that the interview never recorded has no quote of the owner
  // behind it. One that restates a recorded requirement is folded into it (its acceptance
  // criteria are kept, its id goes to mergedFrom); a new one is kept, flagged for the owner to
  // confirm (D-243).
  for (const m of fromModel) {
    if (seen.has(m.id.toUpperCase())) continue;
    const twin = out.findIndex((r) => requirementSimilarity(reqView(r), reqView(m)) >= RESTATEMENT_THRESHOLD);
    const into = twin >= 0 ? out[twin] : undefined;
    if (into) {
      const have = new Set(into.acceptance.map((a) => a.trim().toLowerCase()));
      out[twin] = {
        ...into,
        acceptance: [...into.acceptance, ...m.acceptance.filter((a) => !have.has(a.trim().toLowerCase()))],
        mergedFrom: [...new Set([...(into.mergedFrom ?? []), m.id])],
      };
    } else out.push({ ...m, needsConfirmation: true });
  }
  return out;
}

/** Requirements recorded in state, for the fallback document and to fill gaps in the model's list. */
export function requirementsFromState(state: SessionState): SpecDocument["requirements"] {
  return requirementFacts(state).map((f) => {
    const v = asObject(f.value);
    return {
      id: f.path,
      title: titleOf(f.value, f.path),
      scope: scopeOf(f.value),
      acceptance: Array.isArray(v.acceptance) ? v.acceptance.map(String) : [],
      ...(typeof v.reason === "string" && v.reason ? { reason: v.reason } : {}),
      ...(typeof v.evidence === "string" && v.evidence ? { evidence: v.evidence } : {}),
      ...(v.needsConfirmation === true ? { needsConfirmation: true } : {}),
      ...(Array.isArray(v.mergedFrom) && v.mergedFrom.length ? { mergedFrom: v.mergedFrom.map(String) } : {}),
    };
  });
}

/**
 * The quality pass over the recorded requirements (D-241 to D-243): decisions, constraints and
 * questions filed as functional are rerouted, screen details are folded into their capability,
 * duplicates are merged (plainly equal ones by word overlap, near ones after one cheap model look
 * at those pairs only). The state returned is what the rest of the generation reads.
 */
/** Requirements from which the second, whole-list round runs (D-290). */
const WHOLE_LIST_MIN = 8;

/**
 * Overlap at which a pair is shown to the model, per round (D-290). The second round is the whole
 * list: every pair is a candidate, so a restatement in different words is looked at too.
 */
const MERGE_ROUNDS: DuplicateThresholds[] = [
  { auto: 0.8, candidate: 0.25 },
  { auto: 0.8, candidate: 0.0 },
];

export async function curateForGeneration(
  deps: { caller: ModelCallerPort; prompts: PromptSource; logger: Logger },
  input: { companyId: string; sessionId: string; state: SessionState },
): Promise<{ state: SessionState; report: CurationReport }> {
  let curated = curateRequirements(input.state, {
    thresholds: MERGE_ROUNDS[0] ?? { auto: 0.8, candidate: 0.25 },
  });
  const distinct: { a: string; b: string }[] = [];
  for (let round = 0; round < MERGE_ROUNDS.length; round++) {
    const thresholds = MERGE_ROUNDS[round];
    if (!thresholds) break;
    if (round > 0) {
      // A short list is read whole by its owner; the wide look is for lists a person stops reading.
      if (requirementFacts({ ...input.state, facts: curated.facts }).length < WHOLE_LIST_MIN) continue;
      // The merges of the last round changed the survivors; look again at what is left, wider.
      const again = curateRequirements({ facts: curated.facts }, { thresholds, modelDistinct: distinct });
      curated = { facts: again.facts, report: { ...curated.report, candidates: again.report.candidates } };
    }
    if (curated.report.candidates.length === 0) continue;
    const reqs = requirementFacts({ ...input.state, facts: curated.facts }).map((f) => reqViewOf(f));
    const verdict = await judgeCandidatePairs(deps, {
      companyId: input.companyId,
      sessionId: input.sessionId,
      reqs,
      pairs: curated.report.candidates,
    });
    distinct.push(...verdict.different);
    if (verdict.same.length === 0 && verdict.different.length === 0) continue;
    const next = curateRequirements(
      { facts: curated.facts },
      { thresholds, modelDuplicates: verdict.same, modelDistinct: distinct },
    );
    curated = {
      facts: next.facts,
      report: {
        merged: [...curated.report.merged, ...next.report.merged],
        rerouted: curated.report.rerouted,
        withdrawn: curated.report.withdrawn,
        renumbered: curated.report.renumbered,
        folded: [...curated.report.folded, ...next.report.folded],
        candidates: next.report.candidates,
      },
    };
  }
  return { state: { ...input.state, facts: curated.facts }, report: curated.report };
}

/** The fingerprint a section is written from: the deterministic live rendering of its facts and edit. */
export function sectionBases(input: SpecGenerationInput): Map<string, string> {
  const live = renderLiveSpec({
    title: input.title,
    path: input.path ?? null,
    state: input.state,
    edits: input.edits,
    sections: input.sections,
  });
  return new Map(
    live.sections.map((s) => [
      s.key,
      createHash("sha256").update(`${s.status}\n${s.markdown.trim()}`).digest("hex").slice(0, 16),
    ]),
  );
}

/** The document built without a model: the live spec's sections verbatim, every section marked fallback. */
export function fallbackDocument(input: SpecGenerationInput, now: Date): SpecDocument {
  const live = renderLiveSpec({
    title: input.title,
    path: input.path ?? null,
    state: input.state,
    edits: input.edits,
    sections: input.sections,
  });
  const requirements = requirementsFromState(input.state);
  const bases = sectionBases(input);
  return SpecDocumentSchema.parse({
    title: input.title,
    language: input.language,
    path: input.path ?? null,
    generatedAt: now.toISOString(),
    context: input.state.contextAnswers,
    sections: live.sections
      .filter((s) => input.sections.includes(s.key) || s.status !== "empty")
      .map((s) => ({
        key: s.key,
        title: s.title,
        markdown: s.key === "functional" && s.status !== "edited" ? "" : s.markdown,
        source: s.status === "edited" ? "edited" : "fallback",
        ...(bases.get(s.key) ? { basis: bases.get(s.key) } : {}),
      })),
    requirements,
    mvp: {
      in: requirements.filter((r) => r.scope === "mvp").map((r) => r.id),
      movedOut: requirements
        .filter((r) => r.scope === "future" && r.reason)
        .map((r) => ({ id: r.id, reason: r.reason })),
      next: requirements.filter((r) => r.scope === "future").map((r) => r.id),
    },
  });
}

/** Languages written in a script other than Latin; no script check applies to them. */
const NON_LATIN_LANGUAGES = new Set([
  "zh",
  "ja",
  "ko",
  "ru",
  "uk",
  "bg",
  "sr",
  "ar",
  "fa",
  "he",
  "el",
  "th",
  "hi",
]);
const FOREIGN_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Greek}\p{Extended_Pictographic}]/u;

/** Whether `text` holds letters from a script the document's language is not written in. */
export function hasForeignScript(text: string, language: string): boolean {
  if (NON_LATIN_LANGUAGES.has(language.toLowerCase().split("-")[0] ?? "")) return false;
  return FOREIGN_SCRIPT.test(text);
}

/** Replaces Markdown heading lines written in a foreign script with the section's own title. */
export function cleanHeadings(markdown: string, title: string, language: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      const m = /^(#{1,6})\s+(.*)$/.exec(line);
      return m && hasForeignScript(m[2] ?? "", language) ? `${m[1]} ${title}` : line;
    })
    .join("\n");
}

function openIssues(state: SessionState): Finding[] {
  return state.findings.filter(
    (f) => f.status === "open" || f.status === "raised" || f.status === "deferred",
  );
}

function statsOf(
  doc: SpecDocument,
  issues: Finding[],
  promptVersions: string[],
  generated: "model" | "fallback",
): SpecVersionStats {
  return {
    sections: doc.sections.filter((s) => s.markdown.trim() || s.key === "functional" || s.key === "phases")
      .length,
    requirements: doc.requirements.length,
    mvp: doc.requirements.filter((r) => r.scope === "mvp").length,
    future: doc.requirements.filter((r) => r.scope === "future").length,
    phases: doc.phases.length,
    openFindings: issues.length,
    promptVersions,
    generated,
  };
}

/**
 * Generates one specification version (FR-22 to FR-25): one structured model call over the
 * spec state, owner edits applied as authoritative, then deterministic rendering of spec.md
 * and the agent bundle. Falls back to the live spec when the model call fails, so a version
 * is always produced; the caller stores the result.
 */
export async function generateSpec(
  deps: SpecGenerationDeps,
  rawInput: SpecGenerationInput,
): Promise<SpecGenerationResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { state: curatedState, report: curation } = await curateForGeneration(deps, rawInput);
  const input: SpecGenerationInput = { ...rawInput, state: curatedState };
  const issues = openIssues(input.state);
  const finish = (
    drawn: SpecDocument,
    generated: "model" | "fallback",
    promptVersions: string[],
    error?: string,
  ): SpecGenerationResult => {
    // The owner's diagram edits and additions are laid over whatever was drawn, on the model path
    // and the fallback alike (FR-23, D-214); the generator never sees them.
    const readBack = readBackStatus(rawInput.state);
    const unreviewed =
      readBack !== "confirmed" &&
      drawn.requirements.length > 0 &&
      !drawn.openQuestions.some((q) => q.question === UNREVIEWED_LIST_QUESTION);
    const document: SpecDocument = {
      ...drawn,
      diagrams: mergeDiagrams(drawn.diagrams, input.edits),
      openQuestions: unreviewed
        ? [
            ...drawn.openQuestions,
            { question: UNREVIEWED_LIST_QUESTION, defaultTaken: "The list is built as recorded." },
          ]
        : drawn.openQuestions,
    };
    const markdown = renderSpecMarkdown(document);
    const bundle = renderBundle(document, input.bundleFormat, markdown);
    const min = input.minRequirements ?? 0;
    const failure =
      document.requirements.length < min
        ? `The specification has ${document.requirements.length} functional requirement${document.requirements.length === 1 ? "" : "s"}; at least ${min} are needed to build from. Reopen the interview and describe what the product must do, then generate again.`
        : undefined;
    return {
      document,
      markdown,
      bundle,
      issues,
      stats: statsOf(document, issues, promptVersions, generated),
      generated,
      curation,
      readBack,
      ...(error ? { error } : {}),
      ...(failure ? { failure } : {}),
    };
  };

  let prompt;
  try {
    prompt = await deps.prompts.get(input.companyId, "spec", input.sessionId);
  } catch (e) {
    return finish(fallbackDocument(input, now), "fallback", [], e instanceof Error ? e.message : String(e));
  }
  const promptVersion = promptVersionTag(prompt);
  const promptVersions = [promptVersion];
  try {
    const system = prompt.body
      .replace("{{language}}", languageName(input.language))
      .replace("{{sections}}", input.sections.map((k) => `${k} (${sectionTitle(k)})`).join(", "))
      .replace("{{diagramTypes}}", input.diagramTypes.join(", ") || "none");
    const nonce = newNonce();
    const user = [
      `Title: ${wrapUntrusted("title", input.title || "(untitled)", { nonce })}`,
      input.handoff
        ? `Started from a discovery hand-off: ${wrapUntrusted("handoff", input.handoff.problem, { nonce })}`
        : "",
      "",
      "Specification state:",
      wrapUntrusted("spec_state", renderSpecState(input.state, input.path, input.edits), { nonce }),
      input.summary ? `\nConversation summary:\n${wrapUntrusted("summary", input.summary, { nonce })}` : "",
    ]
      .filter((l) => l !== "")
      .join("\n");
    const out = await deps.caller.complete(
      "spec_generation",
      {
        companyId: input.companyId,
        sessionId: input.sessionId,
        promptVersion,
        ref: { type: "session", id: input.sessionId },
      },
      { system, messages: [{ role: "user", content: user }] },
      SpecGenerationOutputSchema,
      "specification",
    );
    // Headings in another script than the document's language are replaced with the section's own
    // title: a model once answered an English interview with Chinese headings.
    const modelSections = new Map(
      out.sections.map((s) => [s.key, cleanHeadings(s.markdown, sectionTitle(s.key), input.language)]),
    );
    const requirements = mergeRequirements(out.requirements, requirementsFromState(input.state));
    const bases = sectionBases(input);
    const basisOf = (key: string) => (bases.get(key) ? { basis: bases.get(key) } : {});
    const document = SpecDocumentSchema.parse({
      title: hasForeignScript(out.title, input.language) ? input.title : out.title.trim() || input.title,
      language: input.language,
      path: input.path ?? null,
      generatedAt: now.toISOString(),
      context: input.state.contextAnswers,
      sections: input.sections.map((key) => {
        const edit = input.edits[key];
        if (edit?.markdown.trim())
          return {
            key,
            title: sectionTitle(key),
            markdown: edit.markdown,
            source: "edited",
            ...basisOf(key),
          };
        return {
          key,
          title: sectionTitle(key),
          markdown: modelSections.get(key) ?? "",
          source: "generated",
          ...basisOf(key),
        };
      }),
      requirements,
      phases: out.phases,
      openQuestions: out.openQuestions,
      mvp: out.mvp,
      diagrams: out.diagrams.filter((d) => input.diagramTypes.includes(d.type)),
    });
    return finish(document, "model", promptVersions);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    deps.logger.warn("spec generation failed; writing the live spec as the version", {
      sessionId: input.sessionId,
      error,
    });
    return finish(fallbackDocument(input, now), "fallback", promptVersions, error);
  }
}

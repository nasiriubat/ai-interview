import {
  IssueDetectionResultSchema,
  TECHNICAL_SECTIONS,
  normalizeSectionKey,
  type DetectedFinding,
  type Finding,
  type FindingType,
  type InterviewTemplate,
  type Path,
  type SessionState,
} from "@aidp/shared";
import type { ModelCaller } from "../callModel.js";
import type { Logger } from "../engine/ports.js";
import { promptVersionTag, type PromptSource } from "../engine/prompts/index.js";
import { areasComplete, contextComplete } from "../engine/selection.js";
import { languageName } from "../util/language.js";
import { renderSpecState, specFacts } from "./live.js";
import type { RequirementsPolicy } from "./policy.js";

const TYPE_PRIORITY: Record<FindingType, number> = {
  contradiction: 0,
  missing_decision: 1,
  ambiguity: 2,
  over_complexity: 3,
};
const CONFIDENCE_PRIORITY = { high: 0, medium: 1, low: 2 } as const;
const GENTLE_TYPES: ReadonlySet<FindingType> = new Set(["contradiction", "missing_decision"]);

export type ScanReason = "periodic" | "final";

/** Whether this turn starts with an issue-detection pass (every N turns, and once at completion). */
export function shouldScanIssues(
  template: InterviewTemplate,
  state: SessionState,
  policy: RequirementsPolicy,
  path?: Path,
): ScanReason | undefined {
  if (!policy.enabled) return undefined;
  if (state.phase === "done" || state.phase === "summary" || state.closingAsked) return undefined;
  if (!contextComplete(template, state)) return undefined;
  if (state.findings.some((f) => f.status === "open" || f.status === "raised")) return undefined;
  if (specFacts(state).length === 0) return undefined;
  if (areasComplete(template, state, path)) return state.finalIssueScanDone ? undefined : "final";
  if (state.turnCount > 0 && state.turnCount - state.lastIssueScanTurn >= policy.everyTurns)
    return "periodic";
  return undefined;
}

/**
 * Applies the aggressiveness rules (spec 05) and de-duplicates against findings already in
 * state. Gentle: contradictions and missing decisions only. Standard: all enabled types, one
 * per pass. Strict: up to three per pass. On the nontechnical path, findings in technical
 * sections are held to the gentle rule.
 */
export function selectFindings(
  detected: DetectedFinding[],
  existing: Finding[],
  policy: RequirementsPolicy,
  path: Path | undefined,
  turn: number,
): Finding[] {
  const seen = new Set(existing.map((f) => `${f.type}|${f.section}|${f.path ?? ""}`));
  const seenText = new Set(existing.map((f) => f.description.trim().toLowerCase()));
  const allowed = (f: DetectedFinding): boolean => {
    if (!policy.typesEnabled.includes(f.type)) return false;
    const technical = TECHNICAL_SECTIONS.has(normalizeSectionKey(f.section) ?? f.section);
    const level =
      policy.aggressiveness === "gentle" || (path === "nontechnical" && technical)
        ? "gentle"
        : policy.aggressiveness;
    return level !== "gentle" || GENTLE_TYPES.has(f.type);
  };
  const cap = policy.aggressiveness === "strict" ? 3 : 1;
  const picked = detected
    .filter(allowed)
    .filter((f) => !seen.has(`${f.type}|${f.section}|${f.path ?? ""}`))
    .filter((f) => !seenText.has(f.description.trim().toLowerCase()))
    .sort(
      (a, b) =>
        CONFIDENCE_PRIORITY[a.confidence] - CONFIDENCE_PRIORITY[b.confidence] ||
        TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type],
    )
    .slice(0, cap);
  return picked.map((f, i) => ({
    ...f,
    section: normalizeSectionKey(f.section) ?? f.section,
    id: `f${turn}-${i + 1}`,
    status: "open" as const,
    pushedBack: false,
  }));
}

export interface IssueDetectionDeps {
  caller: ModelCaller;
  prompts: PromptSource;
  logger: Logger;
}

/**
 * The separate issue-detection pass (FR-21b): a structured call over the spec state, never
 * the transcript. Returns the findings to add to state; on any failure returns none, so the
 * interview never stalls on this pass.
 */
export async function detectIssues(
  deps: IssueDetectionDeps,
  input: {
    companyId: string;
    sessionId: string;
    template: InterviewTemplate;
    state: SessionState;
    path?: Path;
    policy: RequirementsPolicy;
    reason: ScanReason;
  },
): Promise<Finding[]> {
  try {
    const prompt = await deps.prompts.get(input.companyId, "issues");
    const res = await deps.caller.complete(
      "issue_detection",
      {
        companyId: input.companyId,
        sessionId: input.sessionId,
        promptVersion: promptVersionTag(prompt),
        ref: { type: "session", id: input.sessionId },
      },
      {
        system: prompt.body
          .replace("{{language}}", languageName(input.template.language))
          .replace("{{types}}", input.policy.typesEnabled.join(", ")),
        messages: [
          {
            role: "user",
            content: `${input.reason === "final" ? "Final pass before the specification is closed." : "Periodic pass."}\n\nSpecification state:\n${renderSpecState(input.state, input.path)}`,
          },
        ],
        maxOutputTokens: 4000,
      },
      IssueDetectionResultSchema,
      "findings",
    );
    return selectFindings(
      res.findings,
      input.state.findings,
      input.policy,
      input.path,
      input.state.turnCount,
    );
  } catch (e) {
    deps.logger.warn("issue detection failed; continuing without findings", {
      sessionId: input.sessionId,
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

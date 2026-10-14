import { StateDeltaSchema, type Fact, type SessionState, type StateDelta } from "@aidp/shared";
import type { ModelCallerPort } from "../callModel.js";
import {
  checkSpecFacts,
  nextRequirementNumber,
  salvageRejected,
  type FactRejection,
  type FactRepair,
} from "../spec/delta-validation.js";
import type { Logger } from "./ports.js";
import type { PromptSource } from "./prompts/index.js";
import type { Focus } from "./selection.js";
import { mergeFacts } from "./state.js";
import { parseStateDelta, type TurnMeta } from "./turn-parser.js";
import { repairTurnMeta, type RepairInput } from "./turn-repair.js";

/**
 * The turn contract (D-190): what one interviewer turn must hand back for the engine to trust it,
 * and what the engine does when it does not.
 *
 * The primary channel stays the streamed reply with its trailing metadata, because it costs
 * nothing extra and keeps the participant's text streaming. The contract is enforced after the
 * stream: the metadata must parse, a delta must survive validation, and on a requirements
 * template an answer that informed an area must have produced spec fields. Anything short of that
 * goes to one structured `complete()` call, which the adapter enforces with a JSON schema, and
 * that call rebuilds coverage, decisions and spec facts, not just the message's bookkeeping.
 */

export type ContractReason =
  | "no_metadata"
  | "dropped_fields"
  | "unknown_section"
  | "bad_requirement"
  | "rules_without_requirements"
  | "no_spec_capture";

export interface ContractReport {
  /** `clean`: nothing to fix. `repaired`: fixed (deterministically or by the call). `failed`: a reason stood and the call returned nothing. */
  outcome: "clean" | "repaired" | "failed";
  /** The reply carried no recoverable metadata at all (the parse failure this measures). */
  markerMissed: boolean;
  reasons: ContractReason[];
  repairCalls: number;
  fixed: FactRepair[];
  rejected: FactRejection[];
  /** Facts that no repair could file and that went to open_questions instead of being lost. */
  salvaged: number;
  dropped: string[];
}

export interface ContractInput {
  companyId: string;
  sessionId: string;
  campaignId?: string | undefined;
  /** What the parser recovered from the reply. */
  message: string;
  meta: TurnMeta;
  parseError: string | undefined;
  state: SessionState;
  focus: Focus;
  /** Whether this turn answered a participant message (not the opening turn, not a control). */
  answered: boolean;
  answerMinimal: boolean;
  producesSpec: boolean;
  areas: string;
  focusText: string;
  participantAnswer: string;
  signal?: AbortSignal | undefined;
}

/**
 * The phase of the turn whose question the participant has just answered (`state.phase` is not
 * advanced until after this turn). An answer to an area question or an MVP-challenge question
 * decides spec content; an answer to a context question or a finding does not necessarily.
 */
const CAPTURING_PHASES: ReadonlySet<SessionState["phase"]> = new Set(["areas", "mvp_challenge"]);

const PROBLEM_TEXT: Record<ContractReason, string> = {
  no_metadata: "The report is missing entirely; produce all of it.",
  dropped_fields: "Some fields of the report were malformed and discarded; produce them again.",
  unknown_section: "A fact named a section that is not one of the listed section keys.",
  bad_requirement: "A functional requirement had no usable title.",
  rules_without_requirements:
    "Items were filed under rules and no functional requirement exists; anything the product must do belongs under functional with an FR id.",
  no_spec_capture:
    "The participant answered but no specification fact was recorded; record what the answer decided.",
};

function requirementSummary(state: SessionState, extra: Fact[] = []): string {
  const ids = [...state.facts, ...extra]
    .filter((f) => f.kind === "spec_field" && /^FR-\d+$/i.test(f.path))
    .map((f) => (f.kind === "spec_field" ? f.path : ""));
  return `${ids.length ? [...new Set(ids)].join(", ") : "none"}; the next id is FR-${nextRequirementNumber({ facts: [...state.facts, ...extra] })}`;
}

/** Union of two deltas, the original winning for scalars and the repair filling what was empty. */
function combine(original: StateDelta, repaired: StateDelta, facts: Fact[]): StateDelta {
  const coverage = { ...repaired.coverage, ...original.coverage };
  const known = new Set(original.decisions.map((d) => d.key));
  return StateDeltaSchema.parse({
    ...repaired,
    ...original,
    coverage,
    contextAnswers: { ...repaired.contextAnswers, ...original.contextAnswers },
    decisions: [...original.decisions, ...repaired.decisions.filter((d) => !known.has(d.key))],
    newThreads: original.newThreads.length ? original.newThreads : repaired.newThreads,
    findingOutcomes: original.findingOutcomes,
    facts,
  });
}

export async function settleTurnContract(
  deps: { caller: ModelCallerPort; prompts: PromptSource; logger: Logger },
  input: ContractInput,
): Promise<{ meta: TurnMeta; delta: StateDelta; contract: ContractReport }> {
  const { state, producesSpec } = input;
  let meta = input.meta;
  const markerMissed = Boolean(input.parseError) && Boolean(input.message) && Object.keys(meta).length === 0;
  const reasons: ContractReason[] = [];
  if (markerMissed) reasons.push("no_metadata");

  let parsed = parseStateDelta(meta.stateDelta);
  if (producesSpec && !markerMissed && parsed.dropped.length) reasons.push("dropped_fields");
  const check = checkSpecFacts(parsed.delta.facts, state, { producesSpec });
  if (producesSpec) {
    for (const r of check.rejected) if (!reasons.includes(r.reason)) reasons.push(r.reason);
    const hasSpecFact = check.facts.some((f) => f.kind === "spec_field");
    if (
      !markerMissed &&
      reasons.length === 0 &&
      input.answered &&
      !input.answerMinimal &&
      CAPTURING_PHASES.has(state.phase) &&
      !hasSpecFact
    )
      reasons.push("no_spec_capture");
  }

  const report: ContractReport = {
    outcome: "clean",
    markerMissed,
    reasons,
    repairCalls: 0,
    fixed: check.repaired,
    rejected: check.rejected,
    salvaged: 0,
    dropped: parsed.dropped,
  };

  let delta = { ...parsed.delta, facts: check.facts };
  let heldBack = check.heldBack;
  if (reasons.length > 0 && input.message) {
    report.repairCalls = 1;
    const repairInput: RepairInput = {
      companyId: input.companyId,
      sessionId: input.sessionId,
      campaignId: input.campaignId,
      areas: input.areas,
      focus: input.focusText,
      participantAnswer: input.participantAnswer,
      interviewerMessage: input.message,
      captureSpec: producesSpec,
      problems: reasons.map((r) => PROBLEM_TEXT[r]),
      ...(producesSpec ? { recordedRequirements: requirementSummary(state, check.facts) } : {}),
      ...(check.heldBack.length ? { rejectedFacts: check.heldBack } : {}),
      signal: input.signal,
    };
    const repaired = await repairTurnMeta(deps, repairInput);
    if (repaired) {
      const second = parseStateDelta(repaired.stateDelta);
      // The repaired facts are checked against the state plus what this turn already filed, so ids
      // continue after the accepted ones instead of colliding with them.
      const stateWithTurn = { facts: mergeFacts(state.facts, check.facts) };
      const recheck = checkSpecFacts(second.delta.facts, stateWithTurn, { producesSpec });
      const factsOut = mergeFacts(check.facts, recheck.facts);
      meta = markerMissed ? repaired : { ...repaired, ...meta };
      delta = combine(parsed.delta, second.delta, factsOut);
      heldBack = recheck.heldBack;
      report.fixed = [...report.fixed, ...recheck.repaired];
      report.rejected = recheck.rejected;
      report.dropped = [...report.dropped, ...second.dropped];
      parsed = { delta, dropped: report.dropped };
      report.outcome = "repaired";
    } else {
      report.outcome = reasons.some((r) => r !== "no_spec_capture") ? "failed" : "clean";
      deps.logger.warn("turn contract not restored by the repair call", {
        sessionId: input.sessionId,
        reasons,
      });
    }
  } else if (reasons.length > 0) {
    // Nothing to ask about: no message came back at all.
    report.outcome = "failed";
  } else if (check.repaired.length > 0) {
    report.outcome = "repaired";
  }

  // What no path could file is kept as an open question rather than lost.
  if (heldBack.length > 0) {
    const salvaged = salvageRejected(heldBack);
    delta = { ...delta, facts: mergeFacts(delta.facts, salvaged) };
    report.salvaged = salvaged.length;
  }
  return { meta, delta, contract: report };
}

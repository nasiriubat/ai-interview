import { z } from "zod";
import type { ModelCallerPort } from "../callModel.js";
import { newNonce, wrapUntrusted } from "../util/untrusted.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";
import { NO_CAPTURE_INSTRUCTIONS, SPEC_CAPTURE_INSTRUCTIONS } from "./prompts/interviewer.v7.js";
import { TurnMetaSchema, type TurnMeta } from "./turn-parser.js";

export interface RepairInput {
  companyId: string;
  sessionId: string;
  campaignId?: string | undefined;
  /** The coverage areas and what "covered" means, as the interviewer prompt shows them. */
  areas: string;
  /** The engine focus for the turn that produced the message. */
  focus: string;
  /** The participant's latest answer, if the turn answered one. */
  participantAnswer: string;
  /** The interviewer's message whose metadata is missing. */
  interviewerMessage: string;
  /** True for a template that produces a specification: the call rebuilds spec_field facts too. */
  captureSpec?: boolean;
  /** Why the call is made, in words the model can act on (one per line). */
  problems?: string[];
  /** The requirement ids already recorded and the next one, so ids stay sequential. */
  recordedRequirements?: string;
  /** Facts the turn produced that could not be filed as they were, for the model to re-file. */
  rejectedFacts?: unknown[];
  signal?: AbortSignal | undefined;
}

/**
 * What the repair call returns. The state delta is typed so the adapter's strict `json_schema`
 * (with its JSON-mode fallback) enforces the shape of coverage and facts instead of a trailing
 * marker the model may or may not write; the facts themselves are re-validated by
 * `parseStateDelta` and `checkSpecFacts` like any other delta.
 */
export const TurnDeltaResultSchema = TurnMetaSchema.extend({
  stateDelta: z
    .object({
      coverage: z
        .record(
          z.string(),
          z.object({
            status: z.enum(["partial", "covered", "skipped"]).nullable().optional(),
            known: z.string().nullable().optional(),
            missing: z.string().nullable().optional(),
          }),
        )
        .nullable()
        .optional(),
      contextAnswers: z.record(z.string(), z.string()).nullable().optional(),
      newThreads: z.array(z.unknown()).nullable().optional(),
      decisions: z.array(z.unknown()).nullable().optional(),
      facts: z
        .array(
          z.object({
            kind: z.string(),
            section: z.string().nullable().optional(),
            path: z.string().nullable().optional(),
            value: z.unknown().optional(),
            source: z.string().nullable().optional(),
          }),
        )
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

/**
 * Asks for the metadata a reply left out, or for the facts it filed wrongly. Returns undefined when
 * the call fails or answers nothing usable: the turn then continues with what the reply carried,
 * exactly as it did before this existed. The participant's text goes in as delimited material like
 * everywhere else.
 */
export async function repairTurnMeta(
  deps: { caller: ModelCallerPort; prompts: PromptSource },
  input: RepairInput,
): Promise<TurnMeta | undefined> {
  const prompt = await deps.prompts.get(input.companyId, "turn_meta_repair", input.sessionId);
  const nonce = newNonce();
  const system = prompt.body.replace(
    "{{capture}}",
    input.captureSpec ? SPEC_CAPTURE_INSTRUCTIONS : NO_CAPTURE_INSTRUCTIONS,
  );
  const user = [
    "Coverage areas:",
    input.areas,
    "",
    `<engine_focus>\n${input.focus}\n</engine_focus>`,
    ...(input.recordedRequirements
      ? ["", `Requirements recorded so far: ${input.recordedRequirements}`]
      : []),
    ...(input.problems?.length
      ? ["", "Problems to fix in this report:", ...input.problems.map((p) => `- ${p}`)]
      : []),
    ...(input.rejectedFacts?.length
      ? [
          "",
          "Facts that could not be filed as written (re-file them correctly, or drop them):",
          JSON.stringify(input.rejectedFacts).slice(0, 4000),
        ]
      : []),
    "",
    "Participant's latest answer:",
    wrapUntrusted("participant_turn", input.participantAnswer || "(none yet)", { nonce }),
    "",
    "Interviewer's message:",
    wrapUntrusted("interviewer_message", input.interviewerMessage, { nonce }),
  ].join("\n");
  try {
    const out = await deps.caller.complete(
      "interview_turn",
      {
        companyId: input.companyId,
        sessionId: input.sessionId,
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        promptVersion: promptVersionTag(prompt),
        ref: { type: "session", id: input.sessionId },
      },
      {
        system,
        messages: [{ role: "user", content: user }],
        ...(input.signal ? { signal: input.signal } : {}),
      },
      TurnDeltaResultSchema,
      "turn_delta",
    );
    return out;
  } catch (e) {
    // A cancelled turn must stay cancelled; anything else just means no repair.
    if (e instanceof Error && e.name === "CallAbortedError") throw e;
    return undefined;
  }
}

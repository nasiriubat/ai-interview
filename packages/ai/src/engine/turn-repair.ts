import type { ModelCallerPort } from "../callModel.js";
import { newNonce, wrapUntrusted } from "../util/untrusted.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";
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
  signal?: AbortSignal | undefined;
}

/**
 * Asks for the metadata a reply left out. Returns undefined when the call fails or answers nothing
 * usable: the turn then continues with the message alone, exactly as it did before this existed.
 * The participant's text goes in as delimited material like everywhere else.
 */
export async function repairTurnMeta(
  deps: { caller: ModelCallerPort; prompts: PromptSource },
  input: RepairInput,
): Promise<TurnMeta | undefined> {
  const prompt = await deps.prompts.get(input.companyId, "turn_meta_repair");
  const nonce = newNonce();
  const user = [
    "Coverage areas:",
    input.areas,
    "",
    `<engine_focus>\n${input.focus}\n</engine_focus>`,
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
        system: prompt.body,
        messages: [{ role: "user", content: user }],
        ...(input.signal ? { signal: input.signal } : {}),
      },
      TurnMetaSchema,
      "turn_meta",
    );
    return out;
  } catch (e) {
    // A cancelled turn must stay cancelled; anything else just means no repair.
    if (e instanceof Error && e.name === "CallAbortedError") throw e;
    return undefined;
  }
}

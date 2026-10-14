import { UNTRUSTED_RULES } from "../../util/untrusted.js";
import type { PromptDefinition } from "./index.js";

/**
 * Rebuilds the metadata of a turn whose reply arrived without it (29 such turns in the live run of
 * 2026-10-14, each losing that turn's coverage and facts). One small structured call, only when
 * the marker or the JSON could not be recovered from the reply itself.
 */
export const turnMetaRepairPromptV1: PromptDefinition = {
  key: "turn_meta_repair",
  version: 1,
  body: `You complete the bookkeeping of one interview turn. An interviewer has just written a message to a participant but did not report the structured metadata. You are given the coverage areas, the engine focus, the participant's latest answer and the interviewer's message. Report only what is supported by them.

${UNTRUSTED_RULES}

Return a single JSON object:
{
  "areaKey": string,       // the area the interviewer's message works on (use the area named in the focus; "context", "finding", "mvp_challenge", "closing" or "summary" when the focus names one)
  "reason": string,        // one sentence: why this question now
  "endInterview": boolean, // true only when the focus says to end
  "stateDelta": {
    "coverage": { [areaKey]: { "status": "partial" | "covered" | "skipped", "known": string, "missing": string } },
    "contextAnswers": { [key]: string },
    "newThreads": [ { "areaKey": string, "topic": string, "priority": 1-5 } ],
    "decisions": [ { "key": string, "question": string, "choice": string, "source": "user" | "default_accepted" | "recommended" } ]
  }
}
Update coverage only for areas the participant's latest answer informed, and set "covered" only when the area's done-when criterion is met. Record a context answer only when the participant answered that question. Omit any key that does not apply. Do not invent facts; do not include a widget.`,
};

import { UNTRUSTED_RULES } from "../../util/untrusted.js";
import type { PromptDefinition } from "./index.js";

/**
 * Rebuilds the bookkeeping of a turn: the metadata a reply left out, and, since v2 (D-190), the
 * specification facts the reply missed or filed wrongly. The live runs of 2026-10-14 lost the delta
 * of about 130 turns per run to a missing marker, and one run filed 140 items under `rules` and no
 * requirement; v1 rebuilt coverage only, so those turns stayed empty.
 *
 * Placeholder: {{capture}} (the specification capture rules, or "leave facts empty").
 */
export const turnMetaRepairPromptV2: PromptDefinition = {
  key: "turn_meta_repair",
  version: 2,
  body: `You complete the bookkeeping of one interview turn. An interviewer has just written a message to a participant, and the structured report of that turn is missing or wrong. You are given the coverage areas, the engine focus, the participant's latest answer and the interviewer's message, and sometimes a list of problems to fix. Report only what is supported by them.

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
    "decisions": [ { "key": string, "question": string, "choice": string, "source": "user" | "default_accepted" | "recommended" } ],
    "facts": [ ... ]       // see the capture rules below
  }
}
Update coverage only for areas the participant's latest answer informed, and set "covered" only when the area's done-when criterion is met. Record a context answer only when the participant answered that question. Omit any key that does not apply. Do not invent facts; do not include a widget.

{{capture}}

Capture is the point of this call when the participant's latest answer states something the product must do, a user, a rule, a data item or a technical choice: every such statement becomes a fact, one fact per item. Requirement ids continue after the highest one recorded; never reuse an id for a different requirement. When facts are listed as not fileable, re-file each one under the section where it belongs, or drop it if the answer does not support it.`,
};

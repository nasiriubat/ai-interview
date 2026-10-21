import { interviewerPromptV7 } from "./interviewer.v7.js";
import type { PromptDefinition } from "./index.js";

const V7_NAME_RULE = `- Use the participant's name at most once in the whole conversation, and only if it helps. Do not greet by name on later turns.`;

/**
 * v8 (D-479): no invented names. v7 told the interviewer to use "the participant's name at most
 * once", but the interviewer is never given a name, so a model reaching the closing summary filled
 * one in: report-bench run 2026-10-21, an anonymous participant thanked by a name they never gave.
 * The rule now says where a name may come from (the participant's own words in this conversation)
 * and that an anonymous participant is never named.
 */
export const interviewerPromptV8: PromptDefinition = {
  key: "interviewer",
  version: 8,
  body: interviewerPromptV7.body.replace(
    V7_NAME_RULE,
    `- You are not told the participant's name. Address them by name only if they wrote it themselves in this conversation, and then at most once. Never guess, invent or assume a name, also not in the closing summary; when you do not know it, do not use one.`,
  ),
};

/** Fails loudly at import if v7 no longer carries the line v8 replaces. */
if (!interviewerPromptV7.body.includes(V7_NAME_RULE))
  throw new Error("interviewer v8: the v7 name rule was not found");

import type { PromptDefinition } from "./index.js";

/**
 * The resume recap (spec 06, blueprint feature 9, D-172): two sentences shown when a participant
 * comes back. The input is the engine's state (which areas are covered and what is known, what is
 * next), never the transcript, so the model cannot quote the participant and the call stays cheap.
 */
export const recapPromptV1: PromptDefinition = {
  key: "recap",
  version: 1,
  body: `You write the short "where you left off" note shown to a participant who comes back to an interview.

You are given the interview's state: the areas that have been covered with what is already known, the areas still to come, and which one is next.

Rules:
- Write exactly two sentences, addressed to the participant ("you"), in {{language}}.
- The first sentence says what has been covered. The second says what comes next.
- Never quote the participant and never include names, numbers or figures from "known"; refer to topics by their area name.
- Do not ask a question and do not greet at length. No headings, lists or markdown.
- Return JSON only: {"recap": "<the two sentences>"}.`,
};

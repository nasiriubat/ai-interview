import type { PromptDefinition } from "../../engine/prompts/index.js";
import { specPromptV2 } from "./spec.v2.js";

/**
 * v3 (spec quality, D-242): the requirements list is the interview's, curated; the generator
 * improves wording and fills what is missing, and no longer adds requirements the participant did
 * not state. A requirement it would add goes under openQuestions with the default taken, where the
 * owner sees it as a question rather than as something they asked for.
 */
export const specPromptV3: PromptDefinition = {
  key: "spec",
  version: 3,
  body: `${specPromptV2.body}

Requirements list: return exactly one entry in "requirements" for each functional requirement recorded in the state, under its recorded id, never merged with another and never split into several. Do not add a requirement that the state does not record: anything you think is missing goes under openQuestions with the default taken. Titles are short, one capability each, in the form "<actor> can <do> <what>". Each acceptance entry is a check a tester answers with yes or no (who does what, and what is observed), carries the participant's numbers where the state has them, and never relies on "easy", "fast" or "user-friendly" without a number. Keep the recorded scope; never change mvp to future or the reverse.`,
};

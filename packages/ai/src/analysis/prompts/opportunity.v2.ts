import type { PromptDefinition } from "../../engine/prompts/index.js";
import { UNTRUSTED_RULES } from "../../util/untrusted.js";
import { opportunityPromptV1 } from "./opportunity.v1.js";

/** v2: the facts arrive inside untrusted blocks, and the prompt says what that means. */
export const opportunityPromptV2: PromptDefinition = {
  key: "opportunity",
  version: 2,
  body: `${opportunityPromptV1.body}\n\n${UNTRUSTED_RULES}`,
};

import type { PromptDefinition } from "../../engine/prompts/index.js";
import { UNTRUSTED_RULES } from "../../util/untrusted.js";
import { issuesPromptV2 } from "./issues.v2.js";

/** v3: the specification state arrives inside an untrusted block; the checks are v2's. */
export const issuesPromptV3: PromptDefinition = {
  key: "issues",
  version: 3,
  body: `${issuesPromptV2.body}

${UNTRUSTED_RULES}`,
};

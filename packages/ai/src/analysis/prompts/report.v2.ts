import type { PromptDefinition } from "../../engine/prompts/index.js";
import { UNTRUSTED_RULES } from "../../util/untrusted.js";
import { reportPromptV1 } from "./report.v1.js";

/** v2: titles and summaries are model output derived from interview text; the prompt treats them as data. */
export const reportPromptV2: PromptDefinition = {
  key: "report",
  version: 2,
  body: `${reportPromptV1.body}\n\n${UNTRUSTED_RULES}`,
};

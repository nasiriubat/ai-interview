import type { PromptDefinition } from "../../engine/prompts/index.js";
import { reportPromptV2 } from "./report.v2.js";

/**
 * v3 (D-478): the narrative states only figures it was given. The input carries the campaign's
 * started, completed and analyzed counts, its threshold, and "S of M interviews" for each
 * opportunity; a figure the narrative writes that does not match one of those is removed with its
 * sentence before the report is stored, so the prompt asks for exact counts and no derived ones.
 *
 * Placeholders: {{language}}
 */
export const reportPromptV3: PromptDefinition = {
  key: "report",
  version: 3,
  body: `${reportPromptV2.body}

Figures and quotes:
- Use only the counts given in the input, exactly as given: interviews completed and analyzed, people invited, and "S of M interviews" for an opportunity. Do not compute percentages, averages or totals of your own, and do not estimate hours or money.
- When the completion threshold was not met, or an opportunity rests on one or two interviews, say that the evidence is thin in plain words, without alarm.
- Do not quote participants and do not put anything in quotation marks as if someone said it.`,
};

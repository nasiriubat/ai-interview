import type { PromptDefinition } from "../../engine/prompts/index.js";
import { opportunityPromptV2 } from "./opportunity.v2.js";

/**
 * v3 (D-478): figures and quotes are grounded. The input now says "Mentioned in S of M interviews";
 * the model states counts only as given, does not work out shares or hours of its own, and does not
 * quote participants (verified quotes are attached by the code). Every campaign figure it writes is
 * compared with the computed one, and a sentence whose figure does not match is removed, so the
 * prompt asks for the figures the check can confirm.
 *
 * Placeholders: {{language}}
 */
export const opportunityPromptV3: PromptDefinition = {
  key: "opportunity",
  version: 3,
  body: `${opportunityPromptV2.body}

Figures and quotes:
- When you say how many interviews or people describe this, use exactly the counts given above, in the form "mentioned in S of M interviews". Do not round them, turn them into percentages or add counts of your own.
- Give hours only as the weekly total stated above. Do not multiply, extrapolate or estimate costs.
- Do not quote participants and do not put their words in quotation marks: verified quotes are attached to the opportunity separately.
- When an opportunity is mentioned in only one or two interviews, say so plainly in the rationale and score affected_employees and expected_impact accordingly.`,
};

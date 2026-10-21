import type { PromptDefinition } from "../../engine/prompts/index.js";
import { reportPromptV3 } from "./report.v3.js";

/**
 * v4 (D-479): the narrative follows the ranking. The input lists the ranked opportunities in order,
 * then what works well (no change recommended) and the ideas that were mentioned without a problem
 * behind them, each under its own heading. The executive summary must name the top-ranked items in
 * that order, and any item more interviews mention than those; the code checks the top three and
 * adds a sentence when one is missing. Next steps are concrete: what to do first, which function
 * owns it, and what it rests on, cheap checks first.
 *
 * Placeholders: {{language}}
 */
export const reportPromptV4: PromptDefinition = {
  key: "report",
  version: 4,
  body: `${reportPromptV3.body}

Following the ranking:
- The input lists "Ranked opportunities" in rank order, then "Working well" (areas participants said should stay as they are) and "Ideas mentioned" (suggestions without a reported problem behind them).
- executiveSummary: name the first three ranked opportunities, in that order, each with its "S of M interviews" exactly as given. Then name any other opportunity that more interviews mention than the least-mentioned of those three, with its count: the rank weighs effort and fit, the count says how widespread a problem is, and the reader needs both. When "Working well" lists anything, say in one sentence what works and that no change is recommended there. Do not present an idea as an opportunity.
- nextSteps: one step for each of the first three ranked opportunities, in that order, then (up to five steps in all) one for each opportunity you named for being more widespread. Each says what to do first, which function or role should own it (never a person's name), and what in the interviews it rests on. Put cheap checks and process fixes before larger builds.
- Mention only problems, fixes and figures that are in the input; do not add new ones.`,
};

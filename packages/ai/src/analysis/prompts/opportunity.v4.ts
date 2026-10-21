import type { PromptDefinition } from "../../engine/prompts/index.js";
import { opportunityPromptV3 } from "./opportunity.v3.js";

/**
 * v4 (D-479): every item is grounded in numbered facts.
 *
 * The facts arrive numbered (F1, F2, ...) with an anonymous person label local to the group. The
 * model says which facts support the item (`supportingFacts`): the counts, quotes and evidence are
 * computed from those alone, and an item nothing supports is dropped. It says what the group rests
 * on (`basis`): a reported problem, something that works well (a "no change recommended" item), an
 * idea with no problem behind it (listed apart, unranked) or work described without a problem
 * (dropped). It names the facts whose quote makes a point at least k people make and does not give
 * the speaker away (`sharedQuotes`). Counts are no longer written by the model at all: the report
 * prints them next to each item from the supporting facts, so a sentence cannot disagree with them.
 * Fixes may only name a device, product or data source a participant mentioned.
 *
 * Placeholders: {{language}}
 */
export const opportunityPromptV4: PromptDefinition = {
  key: "opportunity",
  version: 4,
  body: `${opportunityPromptV3.body}

Grounding (this overrides anything above about counts and hours):
- Every fact is numbered (F1, F2, ...) and carries an anonymous person label (person A, person B, ...) that is only meaningful inside this group.
- supportingFacts: the numbers of the facts that directly describe the problem (or, for works_well, the working practice) this item is about. Leave out facts about a different problem, facts only loosely related, and facts that only express a wish. Return an empty list when no fact describes a concrete problem or practice.
- basis: "problem" when participants report pain, time lost, waiting, errors, rework, complaints or risk in this work; "works_well" when they say it works well and should stay as it is (then solutionClass is none and whyNotAi says what works); "idea" when the only material is a suggestion or wish (for example "we should use AI for this") with no problem the participant reported behind it; "no_issue" when the work is described without any problem or praise.
- Base the title, summary and scores only on the supporting facts. Do not state how many interviews or people describe it: the report prints the counts next to the item. Do not add up, average or convert durations or amounts (no weekly totals, no minutes from days); when you give a figure, give one a participant stated, as they stated it. Do not write numbers that are not in the supporting facts.
- Recommend a direction that follows from the facts. Name a specific device, product, system or data source only when a participant mentioned it; otherwise describe the capability.

Anonymity:
- Refer to participants as "participants" or "people", never as he or she, and never by a job title that only one person may hold.
- The input states the anonymity threshold k. When fewer than k people are behind the group, the summary is at most two sentences about the kind of problem, in general terms: no role or team, no names of tools, systems, customers or places, no figures, frequencies or amounts, no tenure, and nothing that says what only one person does, knows or built.
- Never say that a single person is the only one who knows, does or can do something; describe the risk as work that depends on individual knowledge, without saying whose or which role.
- sharedQuotes: the numbers of facts with a quote whose specific point at least k different persons in this group also make, and which does not reveal who said it (no "only I", "I built", unique role, tenure, names or places). Empty when there are none.`,
};

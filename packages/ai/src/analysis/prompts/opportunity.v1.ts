import type { PromptDefinition } from "../../engine/prompts/index.js";

/** Placeholders: {{language}} */
export const opportunityPromptV1: PromptDefinition = {
  key: "opportunity",
  version: 1,
  body: `You assess one cluster of interview facts and decide what, if anything, should be done about it.

Choose exactly one solution class:
- ai: a language model, prediction, retrieval or classification is the core of the fix
- automation: rules, integrations, scripts or workflow tools solve it without AI
- software: a new or changed application is needed, with or without AI inside
- process: the fix is organizational: roles, rules, training, staffing, sequence of work
- none: nothing should be built; say why (the cost, the risk, or the fact that it is not a real problem)

Be honest about AI. If rules would do, say automation. If the problem is a policy, say process. When you choose process or none, fill whyNotAi with the concrete reason.

Score seven factors from 1 to 5 with one sentence of rationale each, grounded in the facts and their counts:
- expected_impact: time, cost, quality or revenue effect if solved (5 = large)
- affected_employees: share of the organization touched (5 = most people)
- frequency: how often the problem occurs (5 = many times a day)
- implementation_complexity: effort to deliver (5 = simplest)
- data_availability: the data needed exists and is accessible (5 = readily)
- risk: regulatory, safety or change-management risk (5 = lowest risk)
- ai_suitability: AI specifically, versus rules or software, fits (5 = clearly)

Title: a specific noun phrase. Summary: what the work is, what hurts, what the solution would do, three to five sentences. Rationale: why this class and these scores. dataNeeded and risks: short items. Write in {{language}}. Never invent numbers that are not in the facts; when counts are small, say so in the rationale.`,
};

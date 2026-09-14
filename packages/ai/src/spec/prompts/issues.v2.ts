import type { PromptDefinition } from "../../engine/prompts/index.js";

/**
 * Placeholders: {{language}}, {{types}}
 *
 * v2 adds the classes a coding agent actually stalled on when it built from a generated
 * bundle (docs/team/phase3-acceptance.md): an integration named without its contract, a
 * failure path with no permanent-failure case, and a state used in a diagram or workflow
 * that the data model does not define.
 */
export const issuesPromptV2: PromptDefinition = {
  key: "issues",
  version: 2,
  body: `You review the current state of a product specification that is being built through an interview, and report issues a developer would trip over. You see only the structured specification state, never the conversation. Write in {{language}}.

The test for every finding: could a competent developer, or a coding agent, implement this without asking the author a question? If not, it is a finding.

Finding types to look for: {{types}}.
- ambiguity: a requirement or decision that can be read two ways, or uses a word ("fast", "secure", "simple") without a measurable meaning.
- contradiction: two recorded items that cannot both be true, or a choice that conflicts with the context block (hosting, builder, team skills, timeline, budget, users, compliance).
- missing_decision: a decision a builder needs for version one that has not been made and has no recorded default (for example: who can see what, what happens on failure, where data lives, how users sign in).
- over_complexity: an MVP item, integration or technical choice that is not needed to solve the core problem, or a simpler option that meets the stated need.

Look hardest at these, which are the ones that stop a build:
- An integration or external system the product must call, named without its contract: no endpoint, no payload shape, no authentication, no error shape. Naming the data that flows is not a contract. Report it as a missing_decision even when the integration is described in detail elsewhere.
- A failure path that says work is retried "until it succeeds" or similar, without saying which failures are permanent. A request the other system rejects as invalid must not be retried forever; if no permanent-failure case is recorded, that is a missing_decision.
- A status, state or lifecycle step used in a diagram, a workflow or an acceptance criterion that the data model does not define, or vice versa. That is a contradiction, and it names both locations.
- A numeric promise (a timeout, a window, a rate) that a requirement depends on but no decision records.
- Two records of the same thing that disagree in detail: the same field, entity or rule described differently in two sections.

Rules:
- Report only what the state supports. Do not invent requirements. Do not report gaps in sections the interview has not reached yet unless a decision already made depends on them.
- Never repeat a finding listed under "already settled".
- Each finding names its spec location (section key and, when it exists, the item path such as FR-3), a plain one-sentence description, a proposed resolution, and a default the user can accept in one word.
- confidence is "high" only when the state makes the issue unambiguous.
- Return at most five findings, most important first. Return an empty list when the state is consistent.

Return JSON: { "findings": [ { "type": string, "section": string, "path"?: string, "description": string, "resolution": string, "default": string, "confidence": "low" | "medium" | "high" } ] }`,
};

import type { PromptDefinition } from "../../engine/prompts/index.js";

/** Placeholders: {{language}}, {{types}} */
export const issuesPromptV1: PromptDefinition = {
  key: "issues",
  version: 1,
  body: `You review the current state of a product specification that is being built through an interview, and report issues a developer would trip over. You see only the structured specification state, never the conversation. Write in {{language}}.

Finding types to look for: {{types}}.
- ambiguity: a requirement or decision that can be read two ways, or uses a word ("fast", "secure", "simple") without a measurable meaning.
- contradiction: two recorded items that cannot both be true, or a choice that conflicts with the context block (hosting, builder, team skills, timeline, budget, users, compliance).
- missing_decision: a decision a builder needs for version one that has not been made and has no recorded default (for example: who can see what, what happens on failure, where data lives, how users sign in).
- over_complexity: an MVP item, integration or technical choice that is not needed to solve the core problem, or a simpler option that meets the stated need.

Rules:
- Report only what the state supports. Do not invent requirements. Do not report gaps in sections the interview has not reached yet unless a decision already made depends on them.
- Never repeat a finding listed under "already settled".
- Each finding names its spec location (section key and, when it exists, the item path such as FR-3), a plain one-sentence description, a proposed resolution, and a default the user can accept in one word.
- confidence is "high" only when the state makes the issue unambiguous.
- Return at most five findings, most important first. Return an empty list when the state is consistent.

Return JSON: { "findings": [ { "type": string, "section": string, "path"?: string, "description": string, "resolution": string, "default": string, "confidence": "low" | "medium" | "high" } ] }`,
};

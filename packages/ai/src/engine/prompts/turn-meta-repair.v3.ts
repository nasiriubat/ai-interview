import { turnMetaRepairPromptV2 } from "./turn-meta-repair.v2.js";
import type { PromptDefinition } from "./index.js";

/**
 * v3 (spec quality, D-242): the capture rules it is given are interviewer v7's; this version adds
 * the two things a rebuild got wrong, filing a capability the interview already holds again and
 * filing a detail of one as a requirement.
 *
 * Placeholder: {{capture}} (the specification capture rules, or "leave facts empty").
 */
export const turnMetaRepairPromptV3: PromptDefinition = {
  key: "turn_meta_repair",
  version: 3,
  body: `${turnMetaRepairPromptV2.body}

Before filing a requirement, check "Requirements recorded" in the context you were given: a capability that is already there is re-recorded under its own id or left out, never filed twice, and the field, label or button of a capability is an acceptance criterion of it, not a requirement.`,
};

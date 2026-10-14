import { extractionPromptV3 } from "./extraction.v3.js";
import type { PromptDefinition } from "./index.js";

/**
 * v4 (spec quality, D-240 to D-243): extraction filed every capability it saw again, because the
 * known facts arrived as paths only ("functional.FR-3"), and filed screen details and decisions as
 * requirements. The known requirements now arrive with their titles, and the rules say what is and
 * is not one. v3's body is otherwise kept; the capture rules ({{specRules}}) are interviewer v7's.
 */
export const extractionPromptV4: PromptDefinition = {
  key: "extraction",
  version: 4,
  body: `${extractionPromptV3.body}

Requirements are the hardest thing to get right, so these rules hold for every functional requirement you return:
- A line starting "spec_field: functional.FR-n =" in the known facts is a requirement already recorded, with its title. Before returning a requirement, compare it with every one of them. If it is the same capability in other words, or a detail of one (a field, a label, a button, a column, a format), do not return it as new: return nothing, or return the existing id again with a fuller acceptance list.
- One requirement is one capability a person can demonstrate and test alone. The parts of a capability are its acceptance criteria.
- A decision, a constraint, a quality target or a question is not a requirement; file it in the section the capture rules name for it.
- Every requirement carries "evidence" inside its value: a short quote copied exactly from a participant block. When no participant block says it, return the fact with source "recommended" and no evidence; never write a quote yourself.`,
};

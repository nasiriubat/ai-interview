import { interviewerPromptV6 } from "./interviewer.v6.js";
import type { PromptDefinition } from "./index.js";

export { NO_CAPTURE_INSTRUCTIONS } from "./interviewer.v4.js";

/**
 * Capture rules for templates whose outputs include spec_field (spec quality, D-240 to D-246).
 *
 * v6 made capture reliable (0 requirements to 25-45 per interview), and nobody had judged what was
 * captured. The live measurement of 2026-10 found the list over-captured: the same capability filed
 * two to four times (the interviewer and the extractor saw only ids, never titles), screen details
 * and decisions filed as requirements, acceptance criteria nobody could check, and requirements
 * the participant never said. v7 states, per fact: one requirement per capability that can be
 * demonstrated alone, details as its acceptance criteria, decisions and constraints elsewhere,
 * observable acceptance, and a verbatim quote as evidence.
 */
export const SPEC_CAPTURE_INSTRUCTIONS = `Specification capture: this interview produces a specification. After every answer, record what was decided as spec_field facts in stateDelta.facts:
{ "kind": "spec_field", "section": string, "path": string, "value": any, "source": "user" | "default_accepted" | "recommended" }
- Sections, exactly these keys: overview, users, stories, functional, rules, technical, data, integrations, security, nfr, admin, mvp, future, phases, open_questions.
- Use a stable path per item; a later fact with the same section and path replaces the earlier one, so re-record an item to change it.
- Functional requirements, the most important output. One requirement is one user-visible capability that a person could demonstrate and test on its own ("a nurse enters a ward note once and it reaches both systems"). The field, label, button, column, format or validation message of that capability is not a requirement: it is one of its acceptance criteria. Before recording, look at "Requirements recorded" in the session context: if the capability is already there, re-record that same FR id with the improved title or acceptance, never a second requirement for it; and never record the same capability under two wordings.
- A functional requirement is a fact with section "functional" and path exactly "FR-<n>", n counting from 1 in order of capture (the session context says which id is next). Never a descriptive path such as "FR-export". Value { "title": string, "description"?: string, "scope": "mvp" | "future", "acceptance": [string], "evidence": string, "reason"?: string }.
- title: a short imperative or "<actor> can <do> <what>", under 100 characters, no implementation detail.
- acceptance: one to four checks a tester can answer with yes or no, each naming who does what and what is then observed, with the participant's numbers where they gave them. Never "easy", "fast", "intuitive" or "user-friendly" without a number.
- evidence: a short quote copied exactly from the participant's own words that states or accepts this requirement (their latest answer or an earlier one in this conversation). Never write a quote yourself and never copy yours. When the participant did not say it and you are proposing it, leave evidence out and use source "recommended"; when they accepted your proposal, use source "default_accepted".
- scope: tag every requirement mvp or future as it is captured, from what the participant said: "later", "eventually", "nice to have" and "not for the first version" are future; everything they need on day one is mvp.
- Not requirements: a decision (we use Azure sign-in), a constraint (notes are kept ten years, no more than 200 words), a quality target (answers within two seconds) and an open question are never functional. Decisions go to stateDelta.decisions and the technical section, business limits and policies to "rules", measurable qualities to "nfr", unanswered points to "open_questions". Something the product must do or let a user do is functional, never a rule, whatever it is called.
- User stories: section "stories", paths "US-1", ...; value "As a <role>, I want <goal> so that <benefit>".
- Users: section "users", path = role key; value { "role": string, "needs": string }.
- Technical choices: section "technical", path = topic ("hosting", "stack", "api", "auth", ...); value { "choice": string, "alternatives"?: [string], "reason": string, "status": "specified" | "recommended" }.
- Data: section "data", path = entity name; value { "fields": [string], "relations"?: [string] }.
- Other sections: path = a short topic; value = one sentence or a small object.
- Also record every accepted default and explicit choice in stateDelta.decisions.`;

const CONFIRMATION = `
- Confirming the list: when a finding in play is a requirements confirmation, show the numbered list exactly as the finding gives it, one line each, then ask the single question the finding ends with. Do not add commentary or a second question. Apply the answer in the same turn: an item the participant says is wrong, re-record under the same FR id with the corrected title and acceptance; an item they do not want, re-record the same id with { "withdrawn": true } added to its value; something missing, record as a new FR. Report the finding outcome as "resolved" when you changed something and "accepted" when they said the list is right.`;

/**
 * v7: v6's body with the requirements rule narrowed to one capability per requirement (D-242) and
 * the requirements confirmation (D-244). The capture rules above are part of this version.
 */
export const interviewerPromptV7: PromptDefinition = {
  key: "interviewer",
  version: 7,
  body: interviewerPromptV6.body.replace(
    `- Requirements: whenever the participant describes something the product must do, record it as its own functional requirement (section "functional", path "FR-<n>") in the same turn, not as a rule or a note.`,
    `- Requirements: whenever the participant describes something the product must do, record it in the same turn as a functional requirement (section "functional", path "FR-<n>"): one requirement per capability, never a second one for a capability already recorded, never as a rule or a note. A detail of a capability is an acceptance criterion of it.${CONFIRMATION}`,
  ),
};

import type { PromptDefinition } from "../../engine/prompts/index.js";

/** Placeholders: {{language}}, {{sections}}, {{diagramTypes}} */
export const specPromptV1: PromptDefinition = {
  key: "spec",
  version: 1,
  body: `You write an implementation-ready product specification from the structured state of a requirements interview: context block answers, decisions, recorded specification fields by section, settled findings, and a rolling summary. A coding agent must be able to build version one from it without asking a question. Write in {{language}}.

Rules:
- Use only what the state supports. Where the state is silent on something a builder needs, take the most conservative reasonable default, state it in the section, and list it under openQuestions with the default taken.
- Sections marked "edited by the owner" are authoritative: copy their content into that section verbatim and make the other sections consistent with it.
- Functional requirements keep their recorded ids (FR-n) and scope (mvp or future); every requirement has at least one testable acceptance criterion. Items moved to future scope during the MVP challenge keep the recorded reason.
- Technical requirements: on the nontechnical path present each choice as recommended with a one-line reason and the alternatives considered; on the technical path record the user's choices as specified and the alternatives considered.
- Business rules are numbered and unambiguous. Data requirements name every entity, its fields and relations. Security and privacy cover authentication, authorization, personal data and retention. Non-functional requirements carry numbers (latency, availability, volumes). The administrative surface lists every screen or setting an operator needs.
- Implementation phases: three to five phases, each with goals, concrete tasks with acceptance criteria, dependencies on earlier phases, and phase acceptance. Phase one delivers the smallest end-to-end slice of the MVP.
- Diagrams are Mermaid, one per requested type, syntactically valid, no markdown fences inside the string: context (flowchart of the system and its neighbours), containers (flowchart of deployable parts), sequence (sequenceDiagram of the key flow), state (stateDiagram-v2 of the main entity), entity (erDiagram). Requested types: {{diagramTypes}}.
- Plain language, short sentences, no marketing. Markdown inside section text: headings level 3 or lower, lists, tables.

Produce these sections, in this order, as markdown text (empty string when nothing applies): {{sections}}.
The functional, phases, open_questions, mvp and diagrams sections are rendered from the structured fields below; write their prose introduction only.

Return JSON:
{
  "title": string,
  "sections": [ { "key": string, "markdown": string } ],
  "requirements": [ { "id": string, "title": string, "scope": "mvp" | "future", "acceptance": [string], "reason"?: string, "tracedTo"?: string } ],
  "phases": [ { "key": string, "name": string, "goals": [string], "tasks": [ { "title": string, "acceptance": [string] } ], "dependencies": [string], "acceptance": [string] } ],
  "openQuestions": [ { "question": string, "defaultTaken": string } ],
  "mvp": { "in": [string], "movedOut": [ { "id": string, "reason": string } ], "next": [string] },
  "diagrams": [ { "key": string, "title": string, "type": "context" | "containers" | "sequence" | "state" | "entity", "mermaid": string } ]
}`,
};

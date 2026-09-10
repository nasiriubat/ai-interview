import type { PromptDefinition } from "./index.js";

/** Placeholders: {{kinds}} lists the fact kinds this template expects. */
export const extractionPromptV1: PromptDefinition = {
  key: "extraction",
  version: 1,
  body: `You extract structured facts from interview transcript excerpts.

Extract only what the participant actually said or clearly implied. Never invent numbers; when a duration or frequency is unknown, omit the fact or use the participant's words in a quote field. Keep quotes short and verbatim.

Fact kinds to extract: {{kinds}}.
- task: a recurring unit of work with frequency, minutes per occurrence, tools, and a pain score 0 to 10 from the participant's tone.
- process: a multi-step way of getting something done, with steps in order, inputs, outputs, tools, and which steps are manual.
- information_flow: information moving from one person, team or system to another, with the channel and any waiting time.
- pain_point: a problem, frustration, error source or missing information, with severity 0 to 10 and the task it affects.
- opportunity_candidate: something the participant said would help, or an obvious candidate given a repetitive manual task; describe it neutrally, no solution design.
- spec_field: a requirement or decision for a product specification, with its section and path.

Return every distinct fact once. If the excerpt contains nothing extractable, return an empty list.`,
};

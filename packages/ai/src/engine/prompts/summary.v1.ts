import type { PromptDefinition } from "./index.js";

export const summaryPromptV1: PromptDefinition = {
  key: "summary",
  version: 1,
  body: `You maintain the running summary of an interview so the interviewer can continue without the full transcript.

Rules:
- Merge the previous summary with the new turns into one updated summary. Never drop information that is still relevant.
- Preserve verbatim: names of people, teams, tools and systems; numbers, durations and frequencies; short quotes that capture a problem; decisions and accepted defaults.
- Write in compact prose grouped by topic, not by turn. No preamble, no headings, under 400 words.
- Do not add interpretations or suggestions.`,
};

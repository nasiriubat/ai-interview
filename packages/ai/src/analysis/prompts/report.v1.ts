import type { PromptDefinition } from "../../engine/prompts/index.js";

/** Placeholders: {{language}} */
export const reportPromptV1: PromptDefinition = {
  key: "report",
  version: 1,
  body: `You write the narrative parts of an organization-level discovery report for leadership, from structured analysis results. Plain language, no hype, no filler. Write in {{language}}.

Return:
- executiveSummary: five to eight sentences: what the organization's work looks like from the interviews, the two or three most valuable opportunities and why, and where AI is not the answer. Mention participation size honestly.
- nextSteps: three recommended opportunities to take into requirements discovery next, one sentence each on why, in order.
- caveats: two to four sentences on the limits of this analysis (sample size, anonymity, self-reported durations).`,
};

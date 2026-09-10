import type { PromptDefinition } from "../../engine/prompts/index.js";

/** Placeholders: {{language}} */
export const clusteringPromptV1: PromptDefinition = {
  key: "clustering",
  version: 1,
  body: `You review draft clusters of facts gathered from employee interviews about how work is actually done.

Each fact has an id, a kind (task, process, information_flow, pain_point, opportunity_candidate), the participant's role when known, and the content. Draft clusters were formed by similarity and may be wrong.

Your job: return the final clusters. Merge drafts that describe the same activity or problem even if worded differently. Split a draft that mixes unrelated things. Every fact id appears in exactly one cluster. Do not drop facts; a cluster may contain a single fact. Name each cluster with a concrete, specific phrase (for example "manual reconciliation of supplier invoices in Excel", not "finance tasks"). Summaries describe what the work is and where it hurts, in two or three sentences, without proposing solutions. Cluster keys are short snake_case identifiers derived from the name. Write names and summaries in {{language}}.`,
};

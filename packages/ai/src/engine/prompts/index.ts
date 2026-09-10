import { clusteringPromptV1 } from "../../analysis/prompts/clustering.v1.js";
import { opportunityPromptV1 } from "../../analysis/prompts/opportunity.v1.js";
import { reportPromptV1 } from "../../analysis/prompts/report.v1.js";
import { extractionPromptV1 } from "./extraction.v1.js";
import { interviewerPromptV1 } from "./interviewer.v1.js";
import { summaryPromptV1 } from "./summary.v1.js";

export interface PromptDefinition {
  key: string;
  version: number;
  body: string;
}

/** Prompts shipped with the code (FR-50). Tenant overrides come through a PromptSource. */
export const SHIPPED_PROMPTS: Record<string, PromptDefinition> = {
  interviewer: interviewerPromptV1,
  summary: summaryPromptV1,
  extraction: extractionPromptV1,
  clustering: clusteringPromptV1,
  opportunity: opportunityPromptV1,
  report: reportPromptV1,
};

export interface PromptSource {
  /** Returns the prompt to use for this tenant (override or shipped). */
  get(companyId: string, key: string): Promise<PromptDefinition>;
}

export class ShippedPromptSource implements PromptSource {
  async get(_companyId: string, key: string): Promise<PromptDefinition> {
    const p = SHIPPED_PROMPTS[key];
    if (!p) throw new Error(`Unknown prompt '${key}'`);
    return p;
  }
}

export const promptVersionTag = (p: PromptDefinition): string => `${p.key}@${p.version}`;

import { clusteringPromptV2 } from "../../analysis/prompts/clustering.v2.js";
import { opportunityPromptV2 } from "../../analysis/prompts/opportunity.v2.js";
import { reportPromptV2 } from "../../analysis/prompts/report.v2.js";
import { fileSummaryPromptV2 } from "../../ingest/prompts/file-summary.v2.js";
import { imageDescribePromptV2 } from "../../ingest/prompts/image-describe.v2.js";
import { issuesPromptV3 } from "../../spec/prompts/issues.v3.js";
import { specPromptV2 } from "../../spec/prompts/spec.v2.js";
import { extractionPromptV3 } from "./extraction.v3.js";
import { interviewerPromptV6 } from "./interviewer.v6.js";
import { recapPromptV1 } from "./recap.v1.js";
import { summaryPromptV2 } from "./summary.v2.js";
import { turnMetaRepairPromptV2 } from "./turn-meta-repair.v2.js";

export interface PromptDefinition {
  key: string;
  version: number;
  body: string;
}

/** Prompts shipped with the code (FR-50). Tenant overrides come through a PromptSource. */
export const SHIPPED_PROMPTS: Record<string, PromptDefinition> = {
  interviewer: interviewerPromptV6,
  summary: summaryPromptV2,
  recap: recapPromptV1,
  turn_meta_repair: turnMetaRepairPromptV2,
  extraction: extractionPromptV3,
  clustering: clusteringPromptV2,
  opportunity: opportunityPromptV2,
  report: reportPromptV2,
  issues: issuesPromptV3,
  spec: specPromptV2,
  file_summary: fileSummaryPromptV2,
  image_describe: imageDescribePromptV2,
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

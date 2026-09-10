import { InterviewTemplateSchema, type InterviewTemplate } from "@aidp/shared";
import opportunityDiscovery from "./opportunity_discovery.json" with { type: "json" };
import requirementsDiscovery from "./requirements_discovery.json" with { type: "json" };

/** Platform templates shipped with the code (FR-65). Validated on load; the admin UI diffs tenant copies against these. */
export function shippedTemplates(): InterviewTemplate[] {
  return [opportunityDiscovery, requirementsDiscovery].map((t) => InterviewTemplateSchema.parse(t));
}

export function shippedTemplate(key: string): InterviewTemplate | undefined {
  return shippedTemplates().find((t) => t.key === key);
}

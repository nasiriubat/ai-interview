import { InterviewTemplateSchema, type InterviewTemplate } from "@aidp/shared";
import type { TemplateRecord } from "@/lib/api/schemas";

/** Drops the record fields (id, owner, status, timestamps); zod strips unknown keys. */
export function toTemplateInput(record: TemplateRecord): InterviewTemplate {
  return InterviewTemplateSchema.parse(record);
}

import { t } from "@/i18n";

/** One thing to fix in a form: where it is, what it is called, and what is wrong with it. */
export interface FormIssue {
  /** DOM id of the field, so the summary can focus it. */
  id: string;
  /** "Coverage areas 2: Key", the place in words. */
  label: string;
  message: string;
  /** Which form section it belongs to, for the per-section count. */
  section?: string | undefined;
}

/** The part of a zod issue this needs; structural so it holds for the library's issue union. */
interface IssueLike {
  code: string;
  message: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  input?: unknown;
}

/**
 * Says what is wrong in the reader's language and in terms of the field, not the schema. The
 * library's own messages are English and technical ("Too small: expected string to have >=1
 * characters"); a Finnish-speaking admin gets the same words in Finnish, and anything unrecognised
 * falls back to the library's text rather than to nothing.
 */
export function issueMessage(issue: IssueLike): string {
  const m = t.admin.form;
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined || issue.input === null ? m.required : m.invalid;
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.origin === "string") return min <= 1 ? m.required : m.tooShort(min);
      if (issue.origin === "array") return min <= 1 ? m.required : m.minItems(min);
      return m.atLeast(min);
    }
    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.origin === "string") return m.tooLong(max);
      if (issue.origin === "array") return m.maxItems(max);
      return m.atMost(max);
    }
    case "invalid_format":
      return m.invalid;
    default:
      return issue.message;
  }
}

/** Counts issues per section, for the badge on each section heading. */
export function countBySection(issues: readonly FormIssue[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of issues) if (i.section) out[i.section] = (out[i.section] ?? 0) + 1;
  return out;
}

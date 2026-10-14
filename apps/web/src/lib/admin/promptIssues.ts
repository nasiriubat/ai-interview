import { t } from "@/i18n";
import type { PromptCheck, PromptIssue } from "@/lib/api/schemas";

/**
 * The reason a prompt body is refused, in the reader's language. The API names the reason by
 * `code` (and the placeholder or marker concerned by `detail`); its own English `message` is
 * for logs and is never shown.
 */
export function issueText(issue: PromptIssue, maxChars: number): string {
  const s = t.admin.prompts.detail.issues;
  const detail = issue.detail ?? "";
  switch (issue.code) {
    case "empty":
      return s.empty;
    case "too_long":
      return s.tooLong(maxChars);
    case "missing_placeholder":
      return s.missingPlaceholder(detail);
    case "unknown_placeholder":
      return s.unknownPlaceholder(detail);
    case "missing_untrusted_rules":
      return s.missingUntrustedRules;
    case "missing_contract_token":
      return s.missingContractToken(detail);
    default:
      return s.unknown;
  }
}

export interface CheckLine {
  /** Stable key for the list. */
  id: string;
  ok: boolean;
  text: string;
}

/** Every line the checks panel shows for one result: the contract issues, then the renderings. */
export function checkLines(check: PromptCheck, maxChars: number): CheckLine[] {
  const s = t.admin.prompts.detail.render;
  const lines: CheckLine[] = check.issues.map((issue, i) => ({
    id: `issue-${String(i)}-${issue.code}`,
    ok: false,
    text: issueText(issue, maxChars),
  }));
  for (const r of check.renders) {
    lines.push({
      id: `render-${r.template}`,
      ok: r.ok,
      text: r.ok
        ? s.ok(r.template, r.chars)
        : r.leftover.length > 0
          ? s.leftover(r.template, r.leftover.map((p) => `{{${p}}}`).join(", "))
          : s.tooLong(r.template, r.chars),
    });
  }
  return lines;
}

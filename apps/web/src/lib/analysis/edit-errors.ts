import { t } from "@/i18n";
import { errorMessage, isApiError } from "@/lib/api/errors";

/**
 * What a refused merge, split or undo says, in the person's language. The API answers 409 with a
 * `details.reason` for every refusal that has a remedy (D-201); anything else is shown as the API
 * worded it.
 */
export function editErrorText(e: unknown, k: number): string {
  const s = t.admin.results;
  if (isApiError(e) && e.details && typeof e.details === "object") {
    const reason = (e.details as { reason?: unknown }).reason;
    switch (reason) {
      case "rerun_required":
        return s.rerunRequired;
      case "stale_analysis":
        return s.onlyNewest;
      case "in_progress":
        return s.inProgress;
      case "below_k":
        return s.split.belowK(k);
    }
  }
  return errorMessage(e, t.app.unknownError);
}

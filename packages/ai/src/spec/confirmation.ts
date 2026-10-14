import type { DetectedFinding, SessionState } from "@aidp/shared";
import { requirementFacts } from "./live.js";
import { curateRequirements, reqViewOf } from "./quality.js";

/** Requirements shown in one confirmation; a longer list is cut and says so. */
export const CONFIRM_LIST_MAX = 30;

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The numbered list the owner is asked to confirm: duplicates folded, withdrawn ones gone. */
export function confirmationLines(state: Pick<SessionState, "facts">): string[] {
  const curated = curateRequirements(state);
  const list = requirementFacts({ ...(state as SessionState), facts: curated.facts }).map((f) =>
    reqViewOf(f),
  );
  const shown = list.slice(0, CONFIRM_LIST_MAX).map((r, i) => {
    const marks = [r.scope === "future" ? "later" : "first version"];
    if (r.needsConfirmation) marks.push("I inferred this, is it right?");
    return `${i + 1}. ${clip(r.title, 90)} (${r.id}; ${marks.join("; ")})`;
  });
  if (list.length > shown.length) shown.push(`...and ${list.length - shown.length} more.`);
  return shown;
}

/**
 * The finding that reads the requirement list back to the owner (D-244). It goes through the
 * existing finding flow: raised as an engine focus, answered in the owner's words, settled by a
 * finding outcome. It is deterministic: no model call and no new mechanism.
 */
export function confirmationFinding(state: Pick<SessionState, "facts">): DetectedFinding | undefined {
  const lines = confirmationLines(state);
  if (lines.length === 0) return undefined;
  return {
    type: "ambiguity",
    section: "functional",
    description: `Requirements confirmation. Read the owner this list, exactly as written, then ask one question: "Is anything on this list wrong or missing?"\n${lines.join("\n")}`,
    resolution:
      "Apply what the owner says: correct or withdraw an item under its FR id, or record what is missing as a new requirement.",
    default: "Keep the list as it is.",
    confidence: "medium",
  };
}

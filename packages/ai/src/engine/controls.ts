import type { CoverageArea, InterviewTemplate, SessionState, TurnControl } from "@aidp/shared";

/** What applying a control did, for the `control` SSE event and the `control` session event. */
export interface AppliedControl {
  kind: TurnControl["type"];
  areaKey?: string;
  /** The area's name, for the one-line note the model is given. */
  areaName?: string;
}

export type ControlResult =
  | { applied: true; state: SessionState; control: AppliedControl }
  | { applied: false; state: SessionState; reason: "unknown_area" | "already_closing" | "already_covered" };

/**
 * Applies a participant control to the session state (D-170).
 *
 * Pure and deliberately separate from `applyDelta`: the delta's coverage guard exists because a
 * model must never lower a status, but a participant is allowed to ("come back to this"). Controls
 * are the only writers that may.
 *
 * - `skip_area` marks the area `skipped` and drops a pending request to return to it.
 * - `return_area` reopens a skipped area as `partial` with its follow-ups reset (a skipped area
 *   that had used its follow-up budget would otherwise be closed the moment it came back) and sets
 *   `requestedAreaKey`, which `chooseFocus` consumes once.
 * - `finish` sets `finishRequested`; the next turn is the closing question. A no-op once the
 *   closing question has already been asked.
 */
export function applyControl(
  state: SessionState,
  template: InterviewTemplate,
  control: TurnControl,
): ControlResult {
  if (control.type === "finish") {
    if (state.closingAsked || state.phase === "done" || state.phase === "summary")
      return { applied: false, state, reason: "already_closing" };
    return {
      applied: true,
      state: { ...state, finishRequested: true },
      control: { kind: "finish" },
    };
  }
  const area: CoverageArea | undefined = template.coverageAreas.find((a) => a.key === control.areaKey);
  if (!area) return { applied: false, state, reason: "unknown_area" };
  const prev = state.coverage[area.key] ?? {
    status: "untouched" as const,
    known: "",
    missing: "",
    followUpsUsed: 0,
  };
  const named = { areaKey: area.key, areaName: area.name };

  if (control.type === "skip_area") {
    // Skipping what was already answered would throw the coverage away.
    if (prev.status === "covered") return { applied: false, state, reason: "already_covered" };
    const { requestedAreaKey, ...rest } = state;
    return {
      applied: true,
      state: {
        ...rest,
        ...(requestedAreaKey && requestedAreaKey !== area.key ? { requestedAreaKey } : {}),
        coverage: { ...state.coverage, [area.key]: { ...prev, status: "skipped" } },
      },
      control: { kind: "skip_area", ...named },
    };
  }

  const reopened =
    prev.status === "skipped" ? { ...prev, status: "partial" as const, followUpsUsed: 0 } : prev;
  return {
    applied: true,
    state: {
      ...state,
      coverage: { ...state.coverage, [area.key]: reopened },
      requestedAreaKey: area.key,
    },
    control: { kind: "return_area", ...named },
  };
}

/**
 * The one line the model is given about a control. It is built from state, never from a
 * fabricated participant utterance, and rides on the focus message of that turn only.
 */
export function controlNote(control: AppliedControl): string {
  switch (control.kind) {
    case "skip_area":
      return `The participant chose to skip "${control.areaName ?? control.areaKey}". Acknowledge it in one sentence, do not raise it again, and move on.`;
    case "return_area":
      return `The participant asked to come back to "${control.areaName ?? control.areaKey}". Welcome them back to it in one sentence and continue there.`;
    case "finish":
      return "The participant asked to end the interview. Do not ask anything new beyond the closing question.";
  }
}

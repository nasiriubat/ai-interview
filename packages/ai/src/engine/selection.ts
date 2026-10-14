import type { CoverageArea, InterviewTemplate, Path, SessionState } from "@aidp/shared";
import { nextMvpItem } from "../spec/live.js";

/** What the engine asks the model to do this turn. Chosen by code, not by the model. */
export type Focus =
  | { mode: "context"; questionKey: string }
  | { mode: "continue"; areaKey: string } // stay on the area: clarify or go deeper
  | { mode: "thread"; areaKey: string; threadId: string; topic: string }
  | { mode: "area"; areaKey: string } // open a new area
  | { mode: "finding"; findingId: string; pushBack: boolean } // raise a detected issue (FR-21b)
  | { mode: "mvp_challenge"; itemPath: string; title: string } // "if version one shipped without this, what breaks?" (FR-22a)
  | { mode: "closing" }
  | { mode: "summary" }
  | { mode: "done" };

export interface SelectionInput {
  template: InterviewTemplate;
  state: SessionState;
  path?: Path;
  maxTurns: number;
  /** True when the participant's last answer was minimal (one or two words). */
  lastAnswerMinimal: boolean;
  /** Requirements sessions: whether the MVP challenge runs before closing. Default off. */
  mvpChallenge?: "mandatory" | "optional" | "off";
}

/** Areas that apply to this session: filtered by path, and by essential when shortened. */
export function applicableAreas(
  template: InterviewTemplate,
  state: SessionState,
  path?: Path,
): CoverageArea[] {
  return template.coverageAreas.filter((a) => {
    if (a.paths && path && !a.paths.includes(path)) return false;
    if (a.paths && !path && a.paths.length > 0) return false;
    if (state.shortened && !a.essential) return false;
    return true;
  });
}

/** True once every context question is answered. */
export function contextComplete(template: InterviewTemplate, state: SessionState): boolean {
  return template.contextBlock.every((q) => q.key in state.contextAnswers);
}

/** True once no applicable area is still open (untouched, or partial with follow-ups left). */
export function areasComplete(template: InterviewTemplate, state: SessionState, path?: Path): boolean {
  return applicableAreas(template, state, path).every((a) => !isOpenArea(a, state));
}

function isOpenArea(a: CoverageArea, state: SessionState): boolean {
  const e = state.coverage[a.key];
  const status = e?.status ?? "untouched";
  return status === "untouched" || (status === "partial" && (e?.followUpsUsed ?? 0) < a.maxFollowUps);
}

export function chooseFocus(input: SelectionInput): Focus {
  const { template, state, path } = input;

  if (state.phase === "done") return { mode: "done" };
  if (state.phase === "summary") return { mode: "summary" };
  if (state.closingAsked) return template.endSummary ? { mode: "summary" } : { mode: "done" };
  // "I'm done" is a state flag, not a counter value (D-170): the next turn is the closing one.
  if (state.finishRequested || state.turnCount >= input.maxTurns) return { mode: "closing" };

  // The participant asked to come back to an area (a `return_area` control): asked next, once.
  // The engine clears `requestedAreaKey` when it takes the turn; it is ignored when the area does
  // not apply to this path.
  if (
    state.requestedAreaKey &&
    applicableAreas(template, state, path).some((a) => a.key === state.requestedAreaKey)
  )
    return { mode: "continue", areaKey: state.requestedAreaKey };

  // 0. Context block, in order, until every question is answered.
  const unanswered = template.contextBlock.find((q) => !(q.key in state.contextAnswers));
  if (unanswered) return { mode: "context", questionKey: unanswered.key };

  // 0b. A detected finding waits to be raised (or pushed back on) before any other question.
  const finding = state.findings.find((f) => f.status === "open");
  if (finding) return { mode: "finding", findingId: finding.id, pushBack: finding.pushedBack };

  const areas = applicableAreas(template, state, path);
  const entry = (key: string) => state.coverage[key];
  const status = (key: string) => entry(key)?.status ?? "untouched";
  const isOpen = (key: string) => {
    const a = areas.find((x) => x.key === key);
    return a !== undefined && isOpenArea(a, state);
  };

  // 1 and 2. Stay on the current area while it is partial, follow-ups remain, and the participant is engaged.
  const current = state.lastAreaKey ? areas.find((a) => a.key === state.lastAreaKey) : undefined;
  if (current && status(current.key) === "partial" && !input.lastAnswerMinimal) {
    const used = entry(current.key)?.followUpsUsed ?? 0;
    if (used < current.maxFollowUps) return { mode: "continue", areaKey: current.key };
  }

  // 3. Highest-priority open thread in an area still open.
  const thread = state.openThreads
    .filter((t) => !t.resolved && areas.some((a) => a.key === t.areaKey) && isOpen(t.areaKey))
    .sort((a, b) => b.priority - a.priority)[0];
  if (thread) return { mode: "thread", areaKey: thread.areaKey, threadId: thread.id, topic: thread.topic };

  // 4. Next area in template order.
  const next = areas.find((a) => isOpen(a.key));
  if (next)
    return next.key === state.lastAreaKey
      ? { mode: "continue", areaKey: next.key }
      : { mode: "area", areaKey: next.key };

  // 5. MVP challenge: walk the MVP list once before finalizing (FR-22a).
  if ((input.mvpChallenge ?? "off") !== "off" && !state.mvpChallenge.done) {
    const item = nextMvpItem(state);
    if (item) return { mode: "mvp_challenge", itemPath: item.path, title: item.title };
  }

  return { mode: "closing" };
}

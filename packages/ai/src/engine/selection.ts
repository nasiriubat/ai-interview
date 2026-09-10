import type { CoverageArea, InterviewTemplate, Path, SessionState } from "@aidp/shared";

/** What the engine asks the model to do this turn. Chosen by code, not by the model. */
export type Focus =
  | { mode: "context"; questionKey: string }
  | { mode: "continue"; areaKey: string } // stay on the area: clarify or go deeper
  | { mode: "thread"; areaKey: string; threadId: string; topic: string }
  | { mode: "area"; areaKey: string } // open a new area
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

export function chooseFocus(input: SelectionInput): Focus {
  const { template, state, path } = input;

  if (state.phase === "done") return { mode: "done" };
  if (state.phase === "summary") return { mode: "summary" };
  if (state.closingAsked) return template.endSummary ? { mode: "summary" } : { mode: "done" };
  if (state.turnCount >= input.maxTurns) return { mode: "closing" };

  // 0. Context block, in order, until every question is answered.
  const unanswered = template.contextBlock.find((q) => !(q.key in state.contextAnswers));
  if (unanswered) return { mode: "context", questionKey: unanswered.key };

  const areas = applicableAreas(template, state, path);
  const entry = (key: string) => state.coverage[key];
  const status = (key: string) => entry(key)?.status ?? "untouched";
  const followUpsLeft = (a: CoverageArea) => (entry(a.key)?.followUpsUsed ?? 0) < a.maxFollowUps;
  // An area is open while untouched, or partial with follow-ups left; an exhausted partial area is left behind.
  const isOpen = (key: string) => {
    const a = areas.find((x) => x.key === key);
    return status(key) === "untouched" || (status(key) === "partial" && a !== undefined && followUpsLeft(a));
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

  return { mode: "closing" };
}

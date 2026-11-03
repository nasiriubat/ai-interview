import type {
  Fact,
  Finding,
  InterviewTemplate,
  SessionState,
  StateDelta,
  Widget,
  WidgetResponse,
} from "@aidp/shared";
import { layerTurnFacts } from "./extracted-facts.js";
import type { Focus } from "./selection.js";

const MINIMAL_MAX_WORDS = 2;
const MINIMAL_MAX_CHARS = 15;

/** A one- or two-word answer with no widget response counts as minimal. */
export function isMinimalAnswer(content: string, widgetResponse?: WidgetResponse): boolean {
  if (widgetResponse) return false;
  const trimmed = content.trim();
  return trimmed.length <= MINIMAL_MAX_CHARS || trimmed.split(/\s+/).length <= MINIMAL_MAX_WORDS;
}

/** Records the participant's answer in state: minimal-answer streak and shortening. */
export function noteUserAnswer(
  state: SessionState,
  template: InterviewTemplate,
  minimal: boolean,
): SessionState {
  const streak = minimal ? state.profile.minimalAnswerStreak + 1 : 0;
  const shortened = state.shortened || streak >= template.adaptivity.minimalAnswerThreshold;
  return {
    ...state,
    profile: {
      ...state.profile,
      minimalAnswerStreak: streak,
      prefersShortAnswers: shortened || state.profile.prefersShortAnswers,
    },
    shortened,
  };
}

let threadCounter = 0;
const newThreadId = (): string => `t${Date.now().toString(36)}${(threadCounter++).toString(36)}`;

/** Requirements-session rules the delta application needs (spec 05). */
export interface DeltaPolicy {
  /** Push back once on a rejected finding the engine is confident about. */
  pushBackOnce: boolean;
  /** A mandatory challenge ignores the user's request to end it early. */
  mvpChallengeMandatory: boolean;
}

const DEFAULT_POLICY: DeltaPolicy = { pushBackOnce: false, mvpChallengeMandatory: false };

/**
 * Applies a model-produced delta with guards: coverage never moves backwards, unknown
 * areas are ignored, follow-up counts are maintained by the engine, threads get ids,
 * spec fields replace earlier values at the same path, finding outcomes follow the
 * push-back rule, and the MVP challenge walk is tracked by the engine.
 */
export function applyDelta(
  state: SessionState,
  delta: StateDelta,
  template: InterviewTemplate,
  focus: Focus,
  policy: DeltaPolicy = DEFAULT_POLICY,
): SessionState {
  const areaKeys = new Set(template.coverageAreas.map((a) => a.key));
  const rank = { untouched: 0, partial: 1, covered: 2, skipped: 2 } as const;
  const coverage = { ...state.coverage };

  for (const [key, patch] of Object.entries(delta.coverage)) {
    if (!areaKeys.has(key)) continue;
    const prev = coverage[key] ?? { status: "untouched" as const, known: "", missing: "", followUpsUsed: 0 };
    const status = patch.status && rank[patch.status] >= rank[prev.status] ? patch.status : prev.status;
    coverage[key] = {
      ...prev,
      status,
      known: patch.known ?? prev.known,
      missing: patch.missing ?? prev.missing,
    };
  }

  const focusArea = "areaKey" in focus ? focus.areaKey : undefined;
  if (focusArea && areaKeys.has(focusArea)) {
    const prev = coverage[focusArea] ?? {
      status: "untouched" as const,
      known: "",
      missing: "",
      followUpsUsed: 0,
    };
    const continuing = focus.mode === "continue";
    const followUpsUsed = continuing ? prev.followUpsUsed + 1 : prev.followUpsUsed;
    const status = prev.status === "untouched" ? "partial" : prev.status;
    const area = template.coverageAreas.find((a) => a.key === focusArea);
    // Follow-up budget exhausted while still partial: move on rather than loop.
    const exhausted = area && status === "partial" && followUpsUsed >= area.maxFollowUps;
    coverage[focusArea] = {
      ...prev,
      status: exhausted ? "covered" : status,
      followUpsUsed,
      missing: exhausted
        ? `${prev.missing} (moved on after ${followUpsUsed} follow-ups)`.trim()
        : prev.missing,
    };
  }

  const resolved = new Set(delta.resolvedThreadIds);
  if (focus.mode === "thread") resolved.add(focus.threadId);
  const openThreads = [
    ...state.openThreads.map((t) => (resolved.has(t.id) ? { ...t, resolved: true } : t)),
    ...delta.newThreads
      .filter((t) => areaKeys.has(t.areaKey))
      .map((t) => ({ ...t, id: newThreadId(), resolved: false })),
  ].slice(-30);

  const decisions = [
    ...state.decisions.filter((d) => !delta.decisions.some((n) => n.key === d.key)),
    ...delta.decisions,
  ];

  const findings = applyFindingOutcomes(state, delta, focus, policy);
  const mvpChallenge = applyMvpChallenge(state, delta, focus, policy);

  const contextAsks =
    focus.mode === "context"
      ? { ...state.contextAsks, [focus.questionKey]: (state.contextAsks[focus.questionKey] ?? 0) + 1 }
      : state.contextAsks;

  return {
    ...state,
    coverage,
    contextAnswers: { ...state.contextAnswers, ...labelContextAnswers(delta.contextAnswers, template) },
    contextAsks,
    profile: mergeDefined(state.profile, delta.profile),
    openThreads,
    decisions,
    facts: delta.facts.length ? mergeFacts(state.facts, delta.facts) : state.facts,
    findings,
    mvpChallenge,
    ...(delta.flagForAdmin ? { flaggedForAdmin: delta.flagForAdmin } : {}),
    lastAreaKey: focusArea ?? state.lastAreaKey,
  };
}

/**
 * A context answer the model recorded as an option key ("onprem") is stored as the option's label
 * ("Company servers"): the workspace and the generated specification show it to people, and the
 * 2026-10-15 simulation showed "Hosting: onprem" and "Who builds it: team". Free text is kept.
 */
export function labelContextAnswers(
  answers: Record<string, string>,
  template: Pick<InterviewTemplate, "contextBlock">,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    const options = template.contextBlock.find((q) => q.key === key)?.options ?? [];
    const hit = options.find((o) => o.key === value.trim());
    out[key] = hit ? hit.label : value;
  }
  return out;
}

/** Appends facts; a spec_field with the same section and path replaces the earlier one (the spec is state, not a log). */
export function mergeFacts(existing: Fact[], incoming: Fact[]): Fact[] {
  const out = [...existing];
  for (const f of incoming) {
    if (f.kind === "spec_field") {
      const idx = out.findIndex(
        (e) => e.kind === "spec_field" && e.section === f.section && e.path === f.path,
      );
      if (idx >= 0) {
        out[idx] = f;
        continue;
      }
    }
    out.push(f);
  }
  return out;
}

/**
 * Finding lifecycle (FR-21b): the focused finding becomes `raised`; outcomes reported for a
 * raised finding are recorded; a rejection of a confident finding is pushed back on once; a
 * raised finding the model did not report on is accepted as is so it never blocks the interview.
 */
function applyFindingOutcomes(
  state: SessionState,
  delta: StateDelta,
  focus: Focus,
  policy: DeltaPolicy,
): Finding[] {
  const turn = state.turnCount;
  const reported = new Map(delta.findingOutcomes.map((o) => [o.id, o]));
  return state.findings.map((f) => {
    if (focus.mode === "finding" && focus.findingId === f.id)
      return { ...f, status: "raised" as const, raisedTurn: turn };
    if (f.status !== "raised") return f;
    const o = reported.get(f.id);
    if (o) {
      if (o.outcome === "rejected") {
        if (policy.pushBackOnce && f.confidence === "high" && !f.pushedBack)
          return { ...f, status: "open" as const, pushedBack: true, ...(o.note ? { note: o.note } : {}) };
        return {
          ...f,
          status: "accepted" as const,
          decidedTurn: turn,
          note: o.note ?? "Kept as is after push-back",
        };
      }
      return { ...f, status: o.outcome, decidedTurn: turn, ...(o.note ? { note: o.note } : {}) };
    }
    // Raised on an earlier turn and not reported on this turn: accepted as is.
    if (f.raisedTurn !== undefined && f.raisedTurn < turn)
      return { ...f, status: "accepted" as const, decidedTurn: turn, note: f.note ?? "No explicit outcome" };
    return f;
  });
}

function applyMvpChallenge(
  state: SessionState,
  delta: StateDelta,
  focus: Focus,
  policy: DeltaPolicy,
): SessionState["mvpChallenge"] {
  let mvp = state.mvpChallenge;
  if (focus.mode === "mvp_challenge") {
    mvp = {
      ...mvp,
      started: true,
      asked: mvp.asked.includes(focus.itemPath) ? mvp.asked : [...mvp.asked, focus.itemPath],
    };
  }
  if (delta.endMvpChallenge && mvp.started && !policy.mvpChallengeMandatory) mvp = { ...mvp, done: true };
  return mvp;
}

/**
 * Whether the template's widget policy lets turn number `turn` carry a widget. The interviewer is
 * told before it writes (D-482), so it never promises options that are then taken away.
 */
export function widgetAllowed(state: SessionState, template: InterviewTemplate, turn: number): boolean {
  const policy = template.widgetPolicy;
  if (policy.maxPerTurns === 0 || policy.allowedTypes.length === 0) return false;
  return state.lastWidgetTurn === 0 || turn - state.lastWidgetTurn >= policy.everyTurns;
}

/** Enforces the template's widget policy; returns the widget to show or undefined. */
export function admitWidget(
  widget: Widget | undefined,
  state: SessionState,
  template: InterviewTemplate,
): Widget | undefined {
  if (!widget) return undefined;
  if (!template.widgetPolicy.allowedTypes.includes(widget.type)) return undefined;
  if (!widgetAllowed(state, template, state.turnCount)) return undefined;
  return widget;
}

/**
 * The choices of a widget that could not be shown, as a plain list to append to the message: the
 * interviewer was told not to list them in its text, so dropping the widget alone would leave
 * "which of these?" with nothing to choose from (D-482). Labels only, so it reads in any language.
 */
export function droppedWidgetText(widget: Widget | undefined): string {
  if (!widget || !("options" in widget)) return "";
  return widget.options.map((o) => `• ${o.label}`).join("\n");
}

/** Shallow merge that ignores undefined patch values, so a partial delta never erases a field. */
function mergeDefined<T extends object>(base: T, patch: object): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * What a whole-state write must not undo.
 *
 * Three writers share one state document: the turn (coverage, counters, spec facts), the summary
 * job (`summaryUpToSeq`) and the extraction job (`facts`, `lastExtractedSeq`). The jobs are
 * published by the same turn and run while the participant is already answering the next
 * question, so a turn that started from an older snapshot routinely finishes after a job has
 * committed. Writing its stale state back would move both cursors backwards, which re-runs
 * extraction over messages already extracted and duplicates their facts.
 *
 * Both cursors only ever grow, so the larger value is always the right one. When the stored
 * extraction cursor is ahead, the incoming document is also missing the facts that run added, so
 * they are kept alongside whatever the incoming document added itself.
 */
export function reconcileBackgroundProgress(stored: SessionState, incoming: SessionState): SessionState {
  const summaryUpToSeq = Math.max(stored.summaryUpToSeq, incoming.summaryUpToSeq);
  if (stored.lastExtractedSeq <= incoming.lastExtractedSeq) return { ...incoming, summaryUpToSeq };
  const known = new Set(stored.facts.map((f) => JSON.stringify(f)));
  const added = incoming.facts.filter((f) => !known.has(JSON.stringify(f)));
  return {
    ...incoming,
    summaryUpToSeq,
    lastExtractedSeq: stored.lastExtractedSeq,
    // Layered, not appended: a requirement the turn recorded under an id the job also filed is one
    // record, or two capabilities with their own numbers (D-302).
    facts: layerTurnFacts(stored.facts, added),
  };
}

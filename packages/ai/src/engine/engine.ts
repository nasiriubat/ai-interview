import type { Modality, SessionState, TurnObject, WidgetResponse } from "@aidp/shared";
import { SessionStateSchema, TurnObjectSchema } from "@aidp/shared";
import type { ModelCallerPort } from "../callModel.js";
import { detectIssues, shouldScanIssues } from "../spec/issues.js";
import { nextMvpItem } from "../spec/live.js";
import { resolvePolicy } from "../spec/policy.js";
import { assembleContext } from "./context.js";
import type {
  EngineSettings,
  Logger,
  RecallSource,
  SessionSnapshot,
  SessionStore,
  StoredMessage,
} from "./ports.js";
import { promptVersionTag, type PromptSource } from "./prompts/index.js";
import { areasComplete, chooseFocus, contextComplete, type Focus } from "./selection.js";
import { admitWidget, applyDelta, isMinimalAnswer, noteUserAnswer } from "./state.js";
import { parseStateDelta, TurnParser } from "./turn-parser.js";

/**
 * A context question asked twice without the model recording the answer is answered with
 * the participant's own words, so the context block can never loop (spec 02 step 0).
 */
function recordStuckContextAnswer(
  state: SessionState,
  session: SessionSnapshot,
  content: string,
  logger: Logger,
): SessionState {
  const current = session.template.contextBlock.find((q) => !(q.key in state.contextAnswers));
  if (!current || (state.contextAsks[current.key] ?? 0) < 2 || !content.trim()) return state;
  logger.warn("context answer recorded from the participant's words after two asks", {
    sessionId: session.id,
    key: current.key,
  });
  return {
    ...state,
    contextAnswers: { ...state.contextAnswers, [current.key]: content.trim().slice(0, 300) },
  };
}

export interface UserAnswer {
  content: string;
  modality: Modality;
  widgetResponse?: WidgetResponse;
}

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "turn"; turn: TurnObject; message: StoredMessage; focus: Focus; state: SessionState }
  | { type: "ended"; state: SessionState };

export interface TurnResult {
  ended: boolean;
  state: SessionState;
  /** The caller schedules these as jobs; the engine never touches a queue. */
  followUps: { summarize: boolean; extract: boolean };
}

export interface EngineDeps {
  caller: ModelCallerPort;
  store: SessionStore;
  prompts: PromptSource;
  recall: RecallSource;
  logger: Logger;
}

/**
 * The template-driven interview loop. One method does one turn: persist the answer,
 * run the issue-detection pass when due, choose the focus, assemble context, stream the
 * model's message, apply the state delta with guards, persist everything.
 * Modality-agnostic; persistence-agnostic.
 */
export class InterviewEngine {
  constructor(private readonly deps: EngineDeps) {}

  /**
   * Runs one interviewer turn. Yields text as it streams, then a `turn` event with the
   * persisted message and new state, or `ended` when the interview is complete.
   */
  async *nextTurn(
    session: SessionSnapshot,
    answer: UserAnswer | undefined,
    settings: EngineSettings,
  ): AsyncGenerator<EngineEvent, TurnResult> {
    const { store, logger } = this.deps;
    let state = SessionStateSchema.parse(session.state);
    if (session.template.pathSelection !== "none" && !session.path) {
      throw new Error("Path must be selected before the first turn");
    }
    const policy = resolvePolicy(session.template, session.path, settings.requirements);

    let lastAnswerMinimal = false;
    if (answer) {
      const last = (await store.recentMessages(session.id, 1))[0];
      await store.appendMessage(session.id, {
        role: "user",
        modality: answer.modality,
        content: answer.content,
        ...(answer.widgetResponse ? { widgetResponse: answer.widgetResponse } : {}),
        ...(last?.widget ? { widget: last.widget } : {}),
      });
      lastAnswerMinimal = isMinimalAnswer(answer.content, answer.widgetResponse);
      state = noteUserAnswer(state, session.template, lastAnswerMinimal);
      state = recordStuckContextAnswer(state, session, answer.content, logger);
    }

    // Issue detection (FR-21b): a separate pass over the spec state, every N turns and once at completion.
    const scan = shouldScanIssues(session.template, state, policy, session.path);
    if (scan) {
      const found = await detectIssues(this.deps, {
        companyId: session.companyId,
        sessionId: session.id,
        template: session.template,
        state,
        ...(session.path ? { path: session.path } : {}),
        policy,
        reason: scan,
      });
      state = {
        ...state,
        findings: [...state.findings, ...found],
        lastIssueScanTurn: state.turnCount,
        ...(scan === "final" ? { finalIssueScanDone: true } : {}),
      };
      if (found.length) {
        await store.appendEvent(session.id, "finding", { kind: "detected", reason: scan, findings: found });
      }
    }

    // MVP challenge bookkeeping: once every area is covered and no item is left, the walk is done.
    if (
      policy.mvpChallenge !== "off" &&
      !state.mvpChallenge.done &&
      contextComplete(session.template, state) &&
      areasComplete(session.template, state, session.path) &&
      !state.findings.some((f) => f.status === "open") &&
      nextMvpItem(state) === undefined
    ) {
      state = { ...state, mvpChallenge: { ...state.mvpChallenge, done: true } };
    }

    const focus = chooseFocus({
      template: session.template,
      state,
      ...(session.path ? { path: session.path } : {}),
      maxTurns: settings.maxTurns,
      lastAnswerMinimal,
      mvpChallenge: policy.mvpChallenge,
    });
    if (focus.mode === "done") {
      state = { ...state, phase: "done" };
      await store.saveState(session.id, state);
      yield { type: "ended", state };
      return { ended: true, state, followUps: { summarize: false, extract: true } };
    }

    const prompt = await this.deps.prompts.get(session.companyId, "interviewer");
    const recent = await store.recentMessages(session.id, settings.recentWindowTurns * 2);
    const recallQuery = "areaKey" in focus ? `${focus.areaKey} ${"topic" in focus ? focus.topic : ""}` : "";
    const recalled =
      recallQuery && state.summaryUpToSeq > 0
        ? await this.deps.recall.recall(session.id, recallQuery, 3)
        : [];
    const ctx = assembleContext({
      prompt,
      session: { ...session, state },
      focus,
      recent,
      recalled,
      settings,
    });

    const parser = new TurnParser();
    const stream = this.deps.caller.chat(
      "interview_turn",
      {
        companyId: session.companyId,
        sessionId: session.id,
        ...(session.campaignId ? { campaignId: session.campaignId } : {}),
        promptVersion: promptVersionTag(prompt),
        ref: { type: "session", id: session.id },
      },
      { system: ctx.system, messages: ctx.messages, cachePrefix: true },
    );
    for await (const ev of stream) {
      if (ev.type === "text") {
        const out = parser.push(ev.text);
        if (out) yield { type: "text", text: out };
      }
    }
    const { message, meta, rest, error } = parser.finish();
    if (rest) yield { type: "text", text: rest };
    if (error)
      logger.warn("turn metadata not parsed; continuing with message only", { sessionId: session.id, error });

    const { delta, dropped } = parseStateDelta(meta.stateDelta);
    if (dropped.length) logger.warn("state delta fields dropped", { sessionId: session.id, dropped });
    const nextTurnCount = state.turnCount + 1;
    state = applyDelta({ ...state, turnCount: nextTurnCount }, delta, session.template, focus, {
      pushBackOnce: policy.pushBackOnce,
      mvpChallengeMandatory: policy.mvpChallenge === "mandatory",
    });
    const widget = admitWidget(meta.widget ?? undefined, state, session.template);
    if (widget) state = { ...state, lastWidgetTurn: nextTurnCount };

    if (focus.mode === "closing") state = { ...state, closingAsked: true, phase: "closing" };
    const ended = focus.mode === "summary" || meta.endInterview === true;
    if (ended) state = { ...state, phase: "done" };
    else if (focus.mode === "context") state = { ...state, phase: "context" };
    else if (focus.mode === "finding") state = { ...state, phase: "findings" };
    else if (focus.mode === "mvp_challenge") state = { ...state, phase: "mvp_challenge" };
    else if (focus.mode !== "closing") state = { ...state, phase: "areas" };

    const turn = TurnObjectSchema.parse({
      message: message || "…",
      ...(widget ? { widget } : {}),
      ...(meta.voiceShortForm ? { voiceShortForm: meta.voiceShortForm } : {}),
      areaKey: "areaKey" in focus ? focus.areaKey : focus.mode,
      stateDelta: delta,
      reason: meta.reason ?? "",
      endInterview: ended,
    });

    const stored = await store.appendMessage(session.id, {
      role: "assistant",
      modality: "text",
      content: turn.message,
      ...(widget ? { widget } : {}),
      areaKey: turn.areaKey ?? focus.mode,
    });
    await store.saveState(session.id, state);
    await store.appendEvent(session.id, "state_delta", {
      focus,
      delta,
      reason: turn.reason,
      tokensEstimate: ctx.tokensEstimate,
      recentTurnsIncluded: ctx.recentTurnsIncluded,
    });
    if (delta.flagForAdmin) await store.appendEvent(session.id, "flag", { reason: delta.flagForAdmin });
    if (focus.mode === "finding")
      await store.appendEvent(session.id, "finding", {
        kind: focus.pushBack ? "pushed_back" : "raised",
        findingId: focus.findingId,
      });
    for (const o of delta.findingOutcomes) {
      const f = state.findings.find((x) => x.id === o.id);
      if (f)
        await store.appendEvent(session.id, "finding", {
          kind: "outcome",
          findingId: o.id,
          outcome: o.outcome,
          status: f.status,
        });
    }

    yield { type: "turn", turn, message: stored, focus, state };
    if (ended) yield { type: "ended", state };

    // The summary folds only turns older than the recent window, so it is due when at least
    // summarizeEveryTurns turns have accumulated beyond that window (not beyond the last fold).
    const sinceSummary = stored.seq - state.summaryUpToSeq - settings.recentWindowTurns * 2;
    const sinceExtract = stored.seq - state.lastExtractedSeq;
    return {
      ended,
      state,
      followUps: {
        summarize: !ended && sinceSummary >= settings.summarizeEveryTurns * 2,
        extract: ended || sinceExtract >= settings.extractEveryTurns * 2,
      },
    };
  }
}

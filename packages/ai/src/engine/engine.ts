import type { Modality, SessionState, TurnObject, WidgetResponse } from "@aidp/shared";
import { SessionStateSchema, StateDeltaSchema, TurnObjectSchema } from "@aidp/shared";
import type { ModelCaller } from "../callModel.js";
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
import { chooseFocus, type Focus } from "./selection.js";
import { admitWidget, applyDelta, isMinimalAnswer, noteUserAnswer } from "./state.js";
import { TurnParser } from "./turn-parser.js";

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
  caller: ModelCaller;
  store: SessionStore;
  prompts: PromptSource;
  recall: RecallSource;
  logger: Logger;
}

/**
 * The template-driven interview loop. One method does one turn: persist the answer,
 * choose the focus, assemble context, stream the model's message, apply the state delta
 * with guards, persist everything. Modality-agnostic; persistence-agnostic.
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
    }

    const focus = chooseFocus({
      template: session.template,
      state,
      ...(session.path ? { path: session.path } : {}),
      maxTurns: settings.maxTurns,
      lastAnswerMinimal,
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

    const delta = StateDeltaSchema.parse(meta.stateDelta ?? {});
    const nextTurnCount = state.turnCount + 1;
    state = applyDelta({ ...state, turnCount: nextTurnCount }, delta, session.template, focus);
    const widget = admitWidget(meta.widget ?? undefined, state, session.template);
    if (widget) state = { ...state, lastWidgetTurn: nextTurnCount };

    if (focus.mode === "closing") state = { ...state, closingAsked: true, phase: "closing" };
    const ended = focus.mode === "summary" || meta.endInterview === true;
    if (ended) state = { ...state, phase: "done" };
    else if (focus.mode === "context") state = { ...state, phase: "context" };
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

    yield { type: "turn", turn, message: stored, focus, state };
    if (ended) yield { type: "ended", state };

    const sinceSummary = stored.seq - state.summaryUpToSeq;
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

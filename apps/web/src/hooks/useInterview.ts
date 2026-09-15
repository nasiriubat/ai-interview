"use client";

import { widgetResponseToText, type Widget, type WidgetResponse } from "@aidp/shared";
import * as React from "react";
import { isApiError } from "@/lib/api/errors";
import type { ParticipantApi, TurnInput } from "@/lib/api/participant";
import type { LiveSpec, Message, ParticipantSession, Progress } from "@/lib/api/schemas";
import { readTurnStream } from "@/lib/api/sse";

export interface InterviewOptions {
  /** Called with the live spec after each turn of a requirements session (`event: spec`, contract 18). */
  onSpec?: (spec: LiveSpec) => void;
}

export interface InterviewError {
  code: string;
  message: string;
}

export interface InterviewState {
  messages: Message[];
  /** Text of the assistant turn currently streaming, or null when idle. */
  streaming: string | null;
  /** A turn is in flight (request sent, stream not finished). */
  pending: boolean;
  progress: Progress;
  ended: boolean;
  summaryAvailable: boolean;
  error: InterviewError | null;
}

export interface InterviewController {
  state: InterviewState;
  /** The widget of the latest interviewer message, when it is still unanswered. */
  activeWidget: Widget | undefined;
  send: (input: TurnInput | undefined) => Promise<void>;
  sendText: (text: string) => Promise<void>;
  sendWidget: (widget: Widget, response: WidgetResponse) => Promise<void>;
  /**
   * Recorded voice (FR-30): uploads the recording as the turn. The transcript arrives first and
   * becomes the participant's own message, before the interviewer answers it.
   */
  sendVoice: (audio: Blob, durationMs?: number) => Promise<void>;
  /** Re-sends the last failed input, or the first turn when nothing was sent yet. */
  retry: () => Promise<void>;
  clearError: () => void;
}

/** What `retry` would send again. A recording is kept in memory so a failed upload can be redone. */
type Attempt =
  | { kind: "first" }
  | { kind: "turn"; input: TurnInput }
  | { kind: "voice"; audio: Blob; durationMs?: number | undefined };

const isCompleted = (status: string): boolean => status === "completed" || status === "deleted";

function localMessage(content: string, input: TurnInput | undefined): Message {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    seq: 0,
    role: "user",
    modality: input?.modality ?? "text",
    content,
    ...(input?.widgetResponse ? { widgetResponse: input.widgetResponse } : {}),
    createdAt: new Date().toISOString(),
  };
}

function heardMessage(text: string): Message {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    seq: 0,
    role: "user",
    modality: "voice",
    content: text,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Drives one interview: optimistic user messages, SSE streaming of the interviewer,
 * progress, ending and errors. Sends the first (empty) turn automatically when the
 * session has no messages yet.
 */
export function useInterview(
  api: ParticipantApi,
  initial: ParticipantSession,
  options: InterviewOptions = {},
): InterviewController {
  const onSpecRef = React.useRef(options.onSpec);
  onSpecRef.current = options.onSpec;
  const [state, setState] = React.useState<InterviewState>({
    messages: initial.messages,
    streaming: null,
    pending: false,
    progress: initial.progress,
    ended: isCompleted(initial.status),
    summaryAvailable: isCompleted(initial.status),
    error: null,
  });
  const abortRef = React.useRef<AbortController | null>(null);
  const lastAttemptRef = React.useRef<Attempt>({ kind: "first" });
  const startedRef = React.useRef(false);

  /**
   * One turn, whatever opened it: typed, widget or recorded. Typed answers show their message
   * immediately; a recording has none until the `transcript` event says what was heard, so the
   * message the server's echo replaces is tracked as the stream runs rather than fixed up front.
   */
  const run = React.useCallback(
    async (
      open: (signal: AbortSignal) => Promise<Response>,
      optimistic: Message | undefined,
    ): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      let localId = optimistic?.id;
      setState((s) => ({
        ...s,
        error: null,
        pending: true,
        streaming: null,
        messages: optimistic ? [...s.messages, optimistic] : s.messages,
      }));

      try {
        const res = await open(controller.signal);
        for await (const ev of readTurnStream(res)) {
          if (controller.signal.aborted) return;
          switch (ev.type) {
            case "text":
              setState((s) => ({ ...s, streaming: (s.streaming ?? "") + ev.delta }));
              break;
            case "transcript": {
              // The participant never typed this, so it is shown as their turn before the reply.
              const heard = heardMessage(ev.text);
              localId = heard.id;
              setState((s) => ({ ...s, messages: [...s.messages, heard] }));
              break;
            }
            case "turn":
              setState((s) => {
                const msg = ev.message;
                let messages = s.messages;
                if (msg.role === "user") {
                  // The server echoes the persisted user message: replace the optimistic one.
                  const idx = localId === undefined ? -1 : messages.findIndex((m) => m.id === localId);
                  messages = idx >= 0 ? messages.map((m, i) => (i === idx ? msg : m)) : [...messages, msg];
                  return { ...s, messages };
                }
                return {
                  ...s,
                  messages: [...messages.filter((m) => m.id !== msg.id), msg],
                  streaming: null,
                  progress: ev.progress.areas.length > 0 ? ev.progress : s.progress,
                  ended: s.ended || ev.ended,
                };
              });
              break;
            case "ended":
              setState((s) => ({
                ...s,
                ended: true,
                summaryAvailable: ev.summaryAvailable,
                streaming: null,
              }));
              break;
            case "spec":
              onSpecRef.current?.(ev.spec);
              break;
            case "error":
              setState((s) => ({ ...s, error: { code: ev.code, message: ev.message }, streaming: null }));
              break;
          }
        }
        setState((s) => {
          // A stream that ended with text but no `turn` event still shows what arrived.
          if (s.streaming && s.streaming.length > 0) {
            const partial: Message = {
              id: `partial-${Date.now()}`,
              seq: 0,
              role: "assistant",
              modality: "text",
              content: s.streaming,
              createdAt: new Date().toISOString(),
            };
            return { ...s, messages: [...s.messages, partial], streaming: null, pending: false };
          }
          return { ...s, pending: false };
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        const code = isApiError(e) ? e.code : "network_error";
        const message = e instanceof Error ? e.message : "";
        setState((s) => ({
          ...s,
          pending: false,
          streaming: null,
          error: { code, message },
          // Keep the optimistic message so a retry can resend it.
        }));
      }
    },
    [],
  );

  const send = React.useCallback(
    (input: TurnInput | undefined): Promise<void> => {
      lastAttemptRef.current = input ? { kind: "turn", input } : { kind: "first" };
      return run(
        (signal) => api.sendTurn(input, signal),
        input ? localMessage(input.content, input) : undefined,
      );
    },
    [api, run],
  );

  const sendVoice = React.useCallback(
    (audio: Blob, durationMs?: number): Promise<void> => {
      lastAttemptRef.current = {
        kind: "voice",
        audio,
        ...(durationMs === undefined ? {} : { durationMs }),
      };
      return run((signal) => api.sendVoice(audio, durationMs, signal), undefined);
    },
    [api, run],
  );

  // Abort an in-flight stream only when the component unmounts. The first-turn guard is
  // reset too, so React's development double-mount (StrictMode) restarts the aborted turn.
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const needsFirstTurn = initial.messages.length === 0 && !isCompleted(initial.status);
  React.useEffect(() => {
    if (startedRef.current || !needsFirstTurn) return;
    // Deferred by a tick so React's development double-mount cancels the first schedule
    // instead of firing two requests; the server also refuses concurrent turns.
    const timer = setTimeout(() => {
      startedRef.current = true;
      void send(undefined);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [needsFirstTurn, send]);

  const activeWidget = React.useMemo((): Widget | undefined => {
    if (state.ended || state.pending) return undefined;
    const last = state.messages[state.messages.length - 1];
    return last?.role === "assistant" && last.widget ? last.widget : undefined;
  }, [state.messages, state.ended, state.pending]);

  const sendText = React.useCallback((text: string) => send({ content: text, modality: "text" }), [send]);
  const sendWidget = React.useCallback(
    (widget: Widget, response: WidgetResponse) =>
      send({ content: widgetResponseToText(widget, response), modality: "widget", widgetResponse: response }),
    [send],
  );
  const retry = React.useCallback(async () => {
    const last = lastAttemptRef.current;
    if (last.kind === "first") return send(undefined);
    // Drop the optimistic copy before re-sending so it is not shown twice.
    setState((s) => ({ ...s, messages: s.messages.filter((m) => !m.id.startsWith("local-")) }));
    if (last.kind === "voice") return sendVoice(last.audio, last.durationMs);
    return send(last.input);
  }, [send, sendVoice]);
  const clearError = React.useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return { state, activeWidget, send, sendText, sendWidget, sendVoice, retry, clearError };
}

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

/**
 * What a screen reader is told when the interviewer finishes speaking. Set exactly once per
 * completed interviewer turn (never per streamed token), so the message is heard once. `n` makes two
 * turns with identical text still distinct for a live region.
 */
export interface Announcement {
  n: number;
  text: string;
  /** The widget under the message, so the announcement can say a question has options. */
  widget?: Widget | undefined;
}

function announce(previous: Announcement | null, message: Message): Announcement {
  return {
    n: (previous?.n ?? 0) + 1,
    text: message.content,
    ...(message.widget ? { widget: message.widget } : {}),
  };
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
  /** The last completed interviewer turn, for the one polite announcement per turn. */
  lastAnnouncement: Announcement | null;
}

/** One interviewer turn as the live voice socket delivers it (FR-30a). */
export interface LiveTurn {
  message: Message;
  ended: boolean;
  progress: Progress;
}

/**
 * How the live voice call (FR-30a) writes into the same conversation.
 *
 * The socket runs the turn itself, so nothing here opens a request; these only fold what came back
 * into the state the message list already renders. That is the point of the cascade: an exchange
 * spoken and an exchange typed are the same `Message` by the time anything downstream sees it.
 */
export interface LiveInterviewSink {
  turn: (turn: LiveTurn) => void;
  /** What the participant was heard to say, shown as their own message before the reply. */
  heard: (text: string) => void;
  ended: (summaryAvailable: boolean) => void;
  failed: (code: string, message: string) => void;
}

export interface InterviewController {
  state: InterviewState;
  live: LiveInterviewSink;
  /** The widget of the latest interviewer message, when it is still unanswered. */
  activeWidget: Widget | undefined;
  /**
   * The send functions resolve `true` when the turn was delivered and answered, `false` when it
   * failed (the error is in `state.error`). The composer uses that to give the text back.
   */
  send: (input: TurnInput | undefined) => Promise<boolean>;
  sendText: (text: string) => Promise<boolean>;
  sendWidget: (widget: Widget, response: WidgetResponse) => Promise<boolean>;
  /**
   * Recorded voice (FR-30): uploads the recording as the turn. The transcript arrives first and
   * becomes the participant's own message, before the interviewer answers it.
   */
  sendVoice: (audio: Blob, durationMs?: number) => Promise<boolean>;
  /** Re-sends the last failed input, or the first turn when nothing was sent yet. */
  retry: () => Promise<boolean>;
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
    lastAnnouncement: null,
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
    ): Promise<boolean> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      let localId = optimistic?.id;
      let failed = false;
      setState((s) => ({
        ...s,
        error: null,
        pending: true,
        streaming: null,
        // A new attempt after a failure replaces the failed one's optimistic copy instead of
        // stacking beside it (the composer hands the text back, so the person may well resend it).
        messages: optimistic
          ? [...(s.error ? s.messages.filter((m) => !m.id.startsWith("local-")) : s.messages), optimistic]
          : s.messages,
      }));

      try {
        const res = await open(controller.signal);
        for await (const ev of readTurnStream(res)) {
          if (controller.signal.aborted) return false;
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
                  lastAnnouncement: announce(s.lastAnnouncement, msg),
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
              failed = true;
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
            return {
              ...s,
              messages: [...s.messages, partial],
              streaming: null,
              pending: false,
              lastAnnouncement: announce(s.lastAnnouncement, partial),
            };
          }
          return { ...s, pending: false };
        });
        return !failed;
      } catch (e) {
        if (controller.signal.aborted) return false;
        const code = isApiError(e) ? e.code : "network_error";
        const message = e instanceof Error ? e.message : "";
        setState((s) => ({
          ...s,
          pending: false,
          streaming: null,
          error: { code, message },
          // Keep the optimistic message so a retry can resend it.
        }));
        return false;
      }
    },
    [],
  );

  const send = React.useCallback(
    (input: TurnInput | undefined): Promise<boolean> => {
      lastAttemptRef.current = input ? { kind: "turn", input } : { kind: "first" };
      return run(
        (signal) => api.sendTurn(input, signal),
        input ? localMessage(input.content, input) : undefined,
      );
    },
    [api, run],
  );

  const sendVoice = React.useCallback(
    (audio: Blob, durationMs?: number): Promise<boolean> => {
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
  const retry = React.useCallback(async (): Promise<boolean> => {
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

  const live = React.useMemo<LiveInterviewSink>(
    () => ({
      turn: (turn) => {
        setState((s) => ({
          ...s,
          error: null,
          pending: false,
          streaming: null,
          messages: [...s.messages.filter((m) => m.id !== turn.message.id), turn.message],
          progress: turn.progress.areas.length > 0 ? turn.progress : s.progress,
          ended: s.ended || turn.ended,
          lastAnnouncement:
            turn.message.role === "assistant"
              ? announce(s.lastAnnouncement, turn.message)
              : s.lastAnnouncement,
        }));
      },
      heard: (text) => {
        const said = text.trim();
        if (said.length === 0) return;
        // `pending` puts the typing indicator up: the engine is working on what was just said.
        setState((s) => ({
          ...s,
          error: null,
          pending: true,
          messages: [...s.messages, heardMessage(said)],
        }));
      },
      ended: (summaryAvailable) => {
        setState((s) => ({ ...s, ended: true, summaryAvailable, pending: false, streaming: null }));
      },
      failed: (code, message) => {
        setState((s) => ({ ...s, error: { code, message }, pending: false, streaming: null }));
      },
    }),
    [],
  );

  return { state, live, activeWidget, send, sendText, sendWidget, sendVoice, retry, clearError };
}

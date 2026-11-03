"use client";

import { widgetResponseToText, type TurnControl, type Widget, type WidgetResponse } from "@aidp/shared";
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

/**
 * What a control leaves in the conversation: a quiet system chip ("You skipped Tools"), not a
 * participant bubble. It is local to this screen and never stored as a message (D-170), so it is
 * gone after a reload, which is right: it is feedback, not a record.
 */
export interface ControlChip {
  kind: "skip_area" | "return_area" | "finish" | "wrap_up";
  areaKey?: string | undefined;
  areaName?: string | undefined;
}

const CHIP_PREFIX = "control-";

function chipMessage(chip: ControlChip, at: string): Message {
  return {
    id: `${CHIP_PREFIX}${at || Date.now()}-${chip.kind}-${chip.areaKey ?? ""}`,
    seq: 0,
    role: "system",
    modality: "text",
    content: "",
    createdAt: at,
    control: chip,
  };
}

/** The chip a message carries, or undefined when it is an ordinary message. */
export function controlChipOf(message: Message): ControlChip | undefined {
  if (message.role !== "system" || !message.id.startsWith(CHIP_PREFIX)) return undefined;
  const chip = (message as { control?: ControlChip }).control;
  return chip?.kind ? chip : undefined;
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
  /**
   * The interviewer's text is complete and the turn's options are being prepared (`event:
   * composing`). Only meaningful while `pending`; every new turn starts it at false.
   */
  composing: boolean;
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
  /** A written answer; `dictated` when the words came from the microphone (D-483). */
  sendText: (text: string, modality?: "text" | "dictated") => Promise<boolean>;
  sendWidget: (widget: Widget, response: WidgetResponse) => Promise<boolean>;
  /**
   * Recorded voice (FR-30): uploads the recording as the turn. The transcript arrives first and
   * becomes the participant's own message, before the interviewer answers it.
   */
  sendVoice: (audio: Blob, durationMs?: number) => Promise<boolean>;
  /**
   * Skip an area, come back to one, or finish: a state operation on the interview, not something
   * said (D-170). The engine acknowledges it in its next turn.
   */
  sendControl: (control: TurnControl) => Promise<boolean>;
  /** Re-sends the last failed input, or the first turn when nothing was sent yet. */
  retry: () => Promise<boolean>;
  clearError: () => void;
}

/**
 * What `retry` would send again. A recording is kept in memory so a failed upload can be redone.
 *
 * `live` is a turn the voice call took: the call itself carries on listening, so there is nothing
 * to resend over HTTP, and resending "nothing" would take an empty turn that skips the question.
 * `none` is an attempt that resending cannot fix (a recording with no speech in it).
 */
type Attempt =
  | { kind: "first" }
  | { kind: "turn"; input: TurnInput }
  | { kind: "control"; control: TurnControl }
  | { kind: "voice"; audio: Blob; durationMs?: number | undefined }
  | { kind: "live" }
  | { kind: "none" };

/**
 * The code a failed recording is reported under when the server heard no speech in it (a 400 from
 * `voice-turns`). Sending the same audio again cannot succeed, so it asks for a new recording.
 */
export const NOT_HEARD = "not_heard";

/** The server's word for a recording that transcribed to nothing (`details.reason`). */
function noSpeech(e: unknown): boolean {
  if (!isApiError(e) || e.code !== "validation") return false;
  const details = e.details as { reason?: unknown } | null | undefined;
  return details?.reason === "no_speech";
}

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
    composing: false,
    progress: initial.progress,
    ended: isCompleted(initial.status),
    summaryAvailable: isCompleted(initial.status),
    error: null,
    lastAnnouncement: null,
  });
  const abortRef = React.useRef<AbortController | null>(null);
  const lastAttemptRef = React.useRef<Attempt>({ kind: "first" });
  const startedRef = React.useRef(false);
  /** The turn in flight, which the next one waits for (see `run`). */
  const inflightRef = React.useRef<Promise<unknown>>(Promise.resolve());
  /**
   * The optimistic bubble of the attempt that failed: the one message a new attempt or a retry may
   * take away. Every answer given in this visit has a `local-` id (the server does not echo the
   * participant's own message back), so removing by prefix would take all of them with it.
   */
  const failedLocalRef = React.useRef<string | null>(null);
  /** Read after waiting for a turn in flight, which may have ended the interview. */
  const endedRef = React.useRef(isCompleted(initial.status));
  /** The screen is gone: nothing queued may start. */
  const goneRef = React.useRef(false);

  /**
   * One turn, whatever opened it: typed, widget or recorded. Typed answers show their message
   * immediately; a recording has none until the `transcript` event says what was heard, so the
   * message the server's echo replaces is tracked as the stream runs rather than fixed up front.
   *
   * Turns are taken one after another, never on top of each other. The server allows one turn per
   * session at a time, and a recording can be finished while the interviewer's reply is still
   * streaming (the microphone stays usable while it does, so the next answer can be given at
   * once). Aborting the reply to make room for the answer lost the reply on screen, and the server
   * was usually still inside that turn, so the answer was refused as a conflict: the recording
   * "could not be sent". So a new turn waits for the one in flight, and only then shows its bubble,
   * which keeps the conversation in order.
   */
  const run = React.useCallback(
    (
      open: (signal: AbortSignal) => Promise<Response>,
      optimistic: Message | undefined,
      retryAs: Attempt,
    ): Promise<boolean> => {
      const go = (): Promise<boolean> => attempt(open, optimistic, retryAs);
      const mine = inflightRef.current.then(go, go);
      inflightRef.current = mine.catch(() => undefined);
      return mine;
    },
    // `attempt` only touches refs and the state setter, which are stable.
    [],
  );

  async function attempt(
    open: (signal: AbortSignal) => Promise<Response>,
    optimistic: Message | undefined,
    retryAs: Attempt,
  ): Promise<boolean> {
    // The turn waited for may have ended the interview; there is nothing left to answer.
    if (endedRef.current || goneRef.current) return false;
    const kind = retryAs.kind;
    // What a retry resends: this attempt, now that it is the one running.
    lastAttemptRef.current = retryAs;
    const controller = new AbortController();
    abortRef.current = controller;

    let localId = optimistic?.id;
    let failed = false;
    const failedBefore = failedLocalRef.current;
    failedLocalRef.current = null;
    setState((s) => ({
      ...s,
      error: null,
      pending: true,
      composing: false,
      streaming: null,
      // A new attempt after a failure replaces the failed one's optimistic copy instead of
      // stacking beside it (the composer hands the text back, so the person may well resend it).
      // Only that copy: the answers that did go through stay where they are.
      messages: [
        ...(failedBefore === null ? s.messages : s.messages.filter((m) => m.id !== failedBefore)),
        ...(optimistic ? [optimistic] : []),
      ],
    }));

    try {
      const res = await open(controller.signal);
      for await (const ev of readTurnStream(res)) {
        if (controller.signal.aborted) return false;
        switch (ev.type) {
          case "text":
            setState((s) => ({ ...s, streaming: (s.streaming ?? "") + ev.delta }));
            break;
          case "composing":
            setState((s) => ({ ...s, composing: true }));
            break;
          case "control": {
            const area = ev.progress.areas.find((a) => a.key === ev.areaKey);
            const chip = chipMessage({ kind: ev.kind, areaKey: ev.areaKey, areaName: area?.name }, ev.at);
            // The chips move at once; the interviewer's turn follows.
            setState((s) => ({
              ...s,
              progress: ev.progress.areas.length > 0 ? ev.progress : s.progress,
              messages: s.messages.some((m) => m.id === chip.id) ? s.messages : [...s.messages, chip],
            }));
            break;
          }
          case "transcript": {
            // The participant never typed this, so it is shown as their turn before the reply.
            const heard = heardMessage(ev.text);
            const placeholder = localId;
            localId = placeholder ?? heard.id;
            // A recording already has its bubble (made when it was sent), so what was heard
            // fills that one instead of adding a second.
            setState((s) => {
              const idx = placeholder === undefined ? -1 : s.messages.findIndex((m) => m.id === placeholder);
              return {
                ...s,
                messages:
                  idx >= 0
                    ? s.messages.map((m, i) =>
                        i === idx ? { ...heard, id: m.id, attachmentId: ev.attachmentId } : m,
                      )
                    : [...s.messages, { ...heard, attachmentId: ev.attachmentId }],
              };
            });
            break;
          }
          case "turn":
            if (ev.message.role !== "user" && ev.ended) endedRef.current = true;
            setState((s) => {
              const msg = ev.message;
              let messages = s.messages;
              if (msg.role === "user") {
                // The server echoes the persisted user message: replace the optimistic one.
                const idx = localId === undefined ? -1 : messages.findIndex((m) => m.id === localId);
                // The recording's id came with the transcript; the persisted message does not carry it.
                const kept = idx >= 0 ? messages[idx]?.attachmentId : undefined;
                const merged = typeof kept === "string" ? { ...msg, attachmentId: kept } : msg;
                messages = idx >= 0 ? messages.map((m, i) => (i === idx ? merged : m)) : [...messages, msg];
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
            endedRef.current = true;
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
            failedLocalRef.current = localId ?? null;
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
      if (kind === "voice" && noSpeech(e)) {
        // The recording reached the server and held no speech. Its bubble would only offer to
        // send the same silence again, so it goes, and the participant is asked to record anew.
        const placeholder = localId;
        lastAttemptRef.current = { kind: "none" };
        setState((s) => ({
          ...s,
          pending: false,
          streaming: null,
          error: { code: NOT_HEARD, message },
          messages: s.messages.filter((m) => m.id !== placeholder),
        }));
        return false;
      }
      failedLocalRef.current = localId ?? null;
      setState((s) => ({
        ...s,
        pending: false,
        streaming: null,
        error: { code, message },
        // Keep the optimistic message so a retry can resend it.
      }));
      return false;
    }
  }

  const send = React.useCallback(
    (input: TurnInput | undefined): Promise<boolean> => {
      return run(
        (signal) => api.sendTurn(input, signal),
        input ? localMessage(input.content, input) : undefined,
        input ? { kind: "turn", input } : { kind: "first" },
      );
    },
    [api, run],
  );

  const sendVoice = React.useCallback(
    (audio: Blob, durationMs?: number): Promise<boolean> =>
      // The bubble appears when the upload starts, empty: it says "sending" and is filled with
      // what was heard.
      run((signal) => api.sendVoice(audio, durationMs, signal), heardMessage(""), {
        kind: "voice",
        audio,
        ...(durationMs === undefined ? {} : { durationMs }),
      }),
    [api, run],
  );

  const sendControl = React.useCallback(
    (control: TurnControl): Promise<boolean> =>
      run((signal) => api.sendControl(control, signal), undefined, { kind: "control", control }),
    [api, run],
  );

  // Abort an in-flight stream only when the component unmounts. The first-turn guard is
  // reset too, so React's development double-mount (StrictMode) restarts the aborted turn.
  // A turn still queued behind it is not started either.
  React.useEffect(() => {
    goneRef.current = false;
    return () => {
      goneRef.current = true;
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

  const sendText = React.useCallback(
    (text: string, modality: "text" | "dictated" = "text") => send({ content: text, modality }),
    [send],
  );
  const sendWidget = React.useCallback(
    (widget: Widget, response: WidgetResponse) =>
      send({ content: widgetResponseToText(widget, response), modality: "widget", widgetResponse: response }),
    [send],
  );
  // The failed attempt's own bubble is replaced by the resend's (see `attempt`), so nothing is shown
  // twice and nothing else is taken away.
  const retry = React.useCallback(async (): Promise<boolean> => {
    const last = lastAttemptRef.current;
    switch (last.kind) {
      case "first":
        return send(undefined);
      case "live":
      case "none":
        // A live call keeps listening after a failed turn, so the way to try again is to speak
        // again; a silent recording has to be recorded again. Either way, nothing is resent.
        setState((s) => ({ ...s, error: null }));
        return true;
      case "voice":
        return sendVoice(last.audio, last.durationMs);
      case "control":
        return sendControl(last.control);
      case "turn":
        return send(last.input);
    }
  }, [send, sendVoice, sendControl]);
  const clearError = React.useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  const live = React.useMemo<LiveInterviewSink>(
    () => ({
      turn: (turn) => {
        if (turn.ended) endedRef.current = true;
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
          composing: false,
          messages: [...s.messages, heardMessage(said)],
        }));
      },
      ended: (summaryAvailable) => {
        endedRef.current = true;
        setState((s) => ({ ...s, ended: true, summaryAvailable, pending: false, streaming: null }));
      },
      failed: (code, message) => {
        lastAttemptRef.current = { kind: "live" };
        setState((s) => ({ ...s, error: { code, message }, pending: false, streaming: null }));
      },
    }),
    [],
  );

  return {
    state,
    live,
    activeWidget,
    send,
    sendText,
    sendWidget,
    sendVoice,
    sendControl,
    retry,
    clearError,
  };
}

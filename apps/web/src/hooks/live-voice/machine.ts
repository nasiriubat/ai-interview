import type { LiveVoiceProblem, LiveVoiceStatus } from "./types";
import type { ClientFrame, HearingMode, ServerFrame, TurnFrame, VoiceFallback } from "@/lib/api/voice-live";

/**
 * The state machine of a live call, as a pure reducer.
 *
 * Everything the hook decides lives here: what the status becomes when a server frame arrives, when
 * the socket drops, when playback ends, and which side effects that calls for. The hook only
 * executes the effects against a real socket, microphone and speaker. That is what makes the
 * transitions testable without a browser: `reduce` takes a state and an event and returns the next
 * state and a list of effects, and nothing in this file touches a global.
 *
 * Effects are returned in the order they have to run. They are commands, not callbacks: executing
 * one may dispatch a further event (playback finishing, a refused autoplay), which is reduced the
 * same way.
 */

export interface CallState {
  status: LiveVoiceStatus;
  /** Whether the server sends captions. */
  captions: boolean;
  /** Whether the tenant allows the participant to interrupt the interviewer by talking. */
  bargeIn: boolean;
  /** The server's voice is gone (or the browser refused to play it); the call goes on in text. */
  textOnly: boolean;
  notHeard: boolean;
  partial: string;
  mode: HearingMode;
  /** Retries spent. One is allowed after an unplanned drop; twice means it is not coming back. */
  reconnects: number;
  /** The call was ended on purpose, so a closing socket is not a failure. Cleared by `start`. */
  ended: boolean;
  /** A fallback has been handed to the participant; it is handed over at most once per call. */
  fellBack: boolean;
  /** The microphone is switched off by the participant: nothing is heard, the call stays up. */
  muted: boolean;
}

export const INITIAL_CALL: CallState = {
  status: "idle",
  captions: false,
  bargeIn: false,
  textOnly: false,
  notHeard: false,
  partial: "",
  mode: "utterance",
  reconnects: 0,
  ended: false,
  fellBack: false,
  muted: false,
};

export type CallEvent =
  | { type: "start" }
  /** The participant ended the call. A no-op when there is none. */
  | { type: "end" }
  /** The participant switched the microphone off or on. A no-op when there is no call. */
  | { type: "mute"; muted: boolean }
  /** The component went away. Unlike `end`, always releases everything. */
  | { type: "unmount" }
  | { type: "frame"; frame: ServerFrame }
  /** The socket closed and nobody asked it to. */
  | { type: "socket_closed" }
  /** `new WebSocket` itself threw. */
  | { type: "socket_failed" }
  /** No microphone, no permission, or the audio graph could not be built: nothing was started. */
  | { type: "open_failed" }
  /** A recording opened: whatever "not heard" said about the last one is out of date. */
  | { type: "utterance_started" }
  /** The recorder stopped on its own accord: the end of an utterance. */
  | { type: "utterance_stopped"; durationMs: number }
  | { type: "recorder_failed" }
  /** The interviewer is being cut off: loudness over the barge threshold, or the stop button. */
  | { type: "interrupt"; keepTalking: boolean }
  | { type: "playback_finished" }
  /** Autoplay refused, or a container this browser cannot decode. */
  | { type: "playback_refused" }
  /** This browser cannot capture PCM, so streaming is impossible; record per utterance instead. */
  | { type: "capture_unavailable" };

export type CallEffect =
  | { type: "send"; frame: ClientFrame }
  /** Open the microphone and the audio graph, then the socket. */
  | { type: "open_devices" }
  | { type: "connect" }
  /** Forget the closed socket without closing it again. */
  | { type: "drop_socket" }
  /** Silence the socket, say `bye`, close it, and release the microphone and the player. */
  | { type: "teardown" }
  | { type: "start_streaming"; sampleRate: number }
  | { type: "stop_streaming" }
  /** Disable or enable the microphone track: a disabled track is silence, and the device stays held. */
  | { type: "set_muted"; muted: boolean }
  | { type: "stop_playback" }
  | { type: "begin_speech"; mime: string }
  | { type: "discard_speech" }
  | { type: "play_speech"; more: boolean }
  | { type: "begin_utterance" }
  | { type: "end_utterance" }
  /** The run of loud polls that makes a barge-in starts over. */
  | { type: "reset_barge" }
  /** The quiet that ends an utterance starts over. */
  | { type: "reset_silence" }
  | { type: "clear_problem" }
  | { type: "problem"; problem: LiveVoiceProblem }
  | { type: "turn"; frame: TurnFrame }
  | { type: "heard"; text: string }
  | { type: "ended"; summaryAvailable: boolean }
  | { type: "error"; code: string; message: string }
  | { type: "unavailable"; fallback: Exclude<VoiceFallback, "captions">; reason: string };

export interface Transition {
  state: CallState;
  effects: CallEffect[];
}

const stay = (state: CallState): Transition => ({ state, effects: [] });

/** Back to listening, unless the call is not live at all. */
function toListening(state: CallState): Transition {
  if (state.status === "idle" || state.status === "unavailable") return stay(state);
  return { state: { ...state, status: "listening" }, effects: [{ type: "reset_silence" }] };
}

/** Closes the call on purpose: the socket is silenced first, so its close is not read as a drop. */
function teardown(state: CallState, next: LiveVoiceStatus): Transition {
  return {
    state: { ...state, ended: true, partial: "", muted: false, status: next },
    effects: [{ type: "teardown" }],
  };
}

/** The cascade cannot hear. Hands the participant a rung of the chain, once. */
function giveUp(state: CallState, fallback: Exclude<VoiceFallback, "captions">, reason: string): Transition {
  if (state.fellBack) return stay(state);
  const closed = teardown({ ...state, fellBack: true }, "unavailable");
  return { state: closed.state, effects: [...closed.effects, { type: "unavailable", fallback, reason }] };
}

/** Cuts the interviewer off, locally and on the server. */
function interrupt(state: CallState, keepTalking: boolean): Transition {
  if (state.status !== "speaking") return stay(state);
  const effects: CallEffect[] = [
    { type: "stop_playback" },
    { type: "send", frame: { type: "barge" } },
    { type: "reset_barge" },
  ];
  if (keepTalking) effects.push({ type: "begin_utterance" });
  return { state: { ...state, status: "listening" }, effects };
}

function onFrame(state: CallState, frame: ServerFrame): Transition {
  switch (frame.type) {
    case "ready": {
      const effects: CallEffect[] = [];
      if (frame.mode === "stream") effects.push({ type: "start_streaming", sampleRate: frame.sampleRate });
      // Say the question that is already on screen, so somebody who switches to voice halfway
      // through hears where they are instead of silence. It takes no turn and stores nothing,
      // and it opens the interview when nothing has been asked yet, so it is unconditional —
      // including after a reconnect, where it re-reads the question the drop interrupted.
      effects.push({ type: "send", frame: { type: "speak_last" } });
      return {
        state: {
          ...state,
          reconnects: 0,
          bargeIn: frame.bargeIn,
          captions: frame.captions,
          mode: frame.mode,
          status: "listening",
        },
        effects,
      };
    }
    case "turn":
      return {
        // With no voice coming, the turn is over the moment the text arrives.
        state: { ...state, status: state.textOnly ? "listening" : "thinking" },
        effects: [{ type: "turn", frame }],
      };
    case "caption":
      // The interviewer's caption repeats the `turn` frame that came immediately before it;
      // rendering both would put every exchange in the list twice.
      return frame.role === "user" ? { state, effects: [{ type: "heard", text: frame.text }] } : stay(state);
    case "caption_partial":
      return { state: { ...state, partial: frame.text }, effects: [] };
    case "caption_final":
      return {
        // The server is answering it now.
        state: { ...state, partial: "", status: state.status === "listening" ? "thinking" : state.status },
        effects: [{ type: "heard", text: frame.text }],
      };
    case "speech_started": {
      const next = { ...state, notHeard: false };
      // The provider heard them start talking. Over the interviewer, that is barge-in: the
      // server already stopped any synthesis still running (`barged`), so only the playback here
      // is left to stop, and `barge` is sent only when the server did not do it itself.
      if (state.status === "speaking" && state.bargeIn) {
        if (frame.barged) {
          return {
            state: { ...next, status: "listening" },
            effects: [{ type: "stop_playback" }, { type: "reset_barge" }],
          };
        }
        return interrupt(next, false);
      }
      return stay(next);
    }
    case "speech_stopped":
      return stay(state);
    case "mode":
      // The server lost its streaming provider (or this browser asked): capture per utterance
      // from now on, and say so, so the server stops discarding what arrives.
      return {
        state: { ...state, partial: "", mode: frame.mode },
        effects: [{ type: "stop_streaming" }, { type: "send", frame: { type: "capture", mode: frame.mode } }],
      };
    case "speech_start":
      // An utterance still open when the interviewer starts talking is closed here rather than
      // left running: the silence detector is paused while the speakers are on, so it would go
      // on recording the interviewer's own voice into the participant's next answer. The server
      // holds what it receives and answers it once this turn is done.
      return {
        state: { ...state, status: "speaking" },
        effects: [
          { type: "end_utterance" },
          { type: "begin_speech", mime: frame.mime },
          { type: "reset_barge" },
        ],
      };
    case "speech_end": {
      if (frame.interrupted) {
        const listening = toListening(state);
        return { state: listening.state, effects: [{ type: "discard_speech" }, ...listening.effects] };
      }
      return { state, effects: [{ type: "play_speech", more: frame.more }] };
    }
    case "first_word":
      // The server already folds this into the session's `voice.live` event, which is where the
      // spec asks for it. Showing a participant their own latency would only make them watch it.
      return stay(state);
    case "not_heard": {
      const listening = toListening({ ...state, notHeard: true, partial: "" });
      return listening;
    }
    case "ended": {
      const closed = teardown(state, "idle");
      return {
        state: closed.state,
        effects: [{ type: "ended", summaryAvailable: frame.summaryAvailable }, ...closed.effects],
      };
    }
    case "error": {
      const cb: CallEffect = { type: "error", code: frame.code, message: frame.message };
      // An exhausted budget pauses the session server-side; carrying on listening would only
      // collect answers nothing will read.
      const next = frame.code === "budget_exceeded" ? teardown(state, "idle") : toListening(state);
      return { state: next.state, effects: [cb, ...next.effects] };
    }
    case "unavailable": {
      if (frame.fallback === "captions") {
        const listening = toListening({ ...state, textOnly: true });
        return { state: listening.state, effects: [{ type: "stop_playback" }, ...listening.effects] };
      }
      return giveUp(state, frame.fallback, frame.reason);
    }
  }
}

export function reduce(state: CallState, event: CallEvent): Transition {
  switch (event.type) {
    case "start":
      if (state.status !== "idle" && state.status !== "unavailable") return stay(state);
      return {
        state: {
          ...state,
          ended: false,
          fellBack: false,
          reconnects: 0,
          textOnly: false,
          notHeard: false,
          muted: false,
          partial: "",
          mode: "utterance",
          status: "connecting",
        },
        effects: [{ type: "clear_problem" }, { type: "open_devices" }],
      };
    case "end":
      if (state.status === "idle") return stay(state);
      return teardown(state, "idle");
    case "mute": {
      if (state.status === "idle" || state.status === "unavailable" || state.muted === event.muted)
        return stay(state);
      // An utterance open when the microphone goes quiet is closed, not left running on silence.
      return {
        state: { ...state, muted: event.muted, partial: event.muted ? "" : state.partial },
        effects: [
          ...(event.muted ? ([{ type: "end_utterance" }] as CallEffect[]) : []),
          { type: "set_muted", muted: event.muted },
        ],
      };
    }
    case "unmount":
      return teardown(state, "idle");
    case "frame":
      return onFrame(state, event.frame);
    case "socket_closed": {
      if (state.ended || state.fellBack) return stay(state);
      const lost: CallEffect[] = [
        { type: "drop_socket" },
        { type: "stop_playback" },
        { type: "end_utterance" },
      ];
      if (state.reconnects === 0) {
        // One retry. A socket that drops mid-answer is usually a blip, and nothing is lost by
        // reopening: every turn so far is already persisted. Twice means it is not coming back.
        return {
          state: { ...state, reconnects: 1, status: "connecting" },
          effects: [...lost, { type: "connect" }],
        };
      }
      // The socket, not the cascade: the transcription route is presumably fine, so the record
      // button is worth offering.
      const gone = giveUp(state, "recorded", "connection_lost");
      return {
        state: gone.state,
        effects: [...lost, { type: "problem", problem: "lost" }, ...gone.effects],
      };
    }
    case "socket_failed":
      return giveUp(state, "recorded", "socket_failed");
    case "open_failed":
      return { state: { ...state, status: "idle" }, effects: [] };
    case "utterance_started":
      return stay(state.notHeard ? { ...state, notHeard: false } : state);
    case "utterance_stopped":
      return {
        // Answering may take a few seconds; say so rather than leaving "listening" on screen.
        state: { ...state, status: state.status === "listening" ? "thinking" : state.status },
        effects: [{ type: "send", frame: { type: "utterance", durationMs: event.durationMs } }],
      };
    case "recorder_failed": {
      // The audio already on the server is half an answer; better discarded than transcribed.
      const listening = toListening(state);
      return {
        state: listening.state,
        effects: [
          { type: "send", frame: { type: "cancel" } },
          { type: "problem", problem: "failed" },
          ...listening.effects,
        ],
      };
    }
    case "interrupt":
      return interrupt(state, event.keepTalking);
    case "playback_finished":
      return toListening(state);
    case "playback_refused": {
      // The text is already on screen, so the call carries on without the voice.
      return toListening({ ...state, textOnly: true });
    }
    case "capture_unavailable":
      return {
        state: { ...state, mode: "utterance" },
        effects: [
          { type: "stop_streaming" },
          { type: "send", frame: { type: "capture", mode: "utterance" } },
        ],
      };
  }
}

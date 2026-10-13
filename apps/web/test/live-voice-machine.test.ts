import { describe, expect, it } from "vitest";
import {
  INITIAL_CALL,
  reduce,
  type CallEffect,
  type CallEvent,
  type CallState,
} from "@/hooks/live-voice/machine";
import {
  BARGE_POLLS,
  BARGE_RMS,
  INITIAL_VAD,
  MAX_UTTERANCE_MS,
  METER_STEPS,
  meterStep,
  SILENCE_MS,
  SPEECH_RMS,
  vadStep,
  type VadInput,
  type VadState,
} from "@/hooks/live-voice/vad";
import type { ServerFrame } from "@/lib/api/voice-live";

/*
 * The call's state machine and the speech detector are pure, so these tests need no browser: no
 * socket, no audio, no timers. Each test is a sequence of events and an assertion on the status
 * and the effects the hook would be asked to run.
 */

const frame = (f: Record<string, unknown>): CallEvent => ({ type: "frame", frame: f as ServerFrame });

/** Runs events in order, collecting the effects of the last one. */
function play(
  events: CallEvent[],
  from: CallState = INITIAL_CALL,
): { state: CallState; effects: CallEffect[] } {
  let state = from;
  let effects: CallEffect[] = [];
  for (const e of events) {
    const next = reduce(state, e);
    state = next.state;
    effects = next.effects;
  }
  return { state, effects };
}

const types = (effects: CallEffect[]): string[] => effects.map((e) => e.type);

const ready = (over: Record<string, unknown> = {}): CallEvent =>
  frame({ type: "ready", captions: true, bargeIn: true, mode: "utterance", sampleRate: 24000, ...over });

const live = (over: Partial<CallState> = {}): CallState => ({
  ...play([{ type: "start" }, ready()]).state,
  ...over,
});

describe("call state machine: starting and ending", () => {
  it("connects on start and asks the hook to open the devices", () => {
    const { state, effects } = reduce(INITIAL_CALL, { type: "start" });
    expect(state.status).toBe("connecting");
    expect(types(effects)).toEqual(["clear_problem", "open_devices"]);
  });

  it("ignores start while a call is live", () => {
    const { state, effects } = reduce(live(), { type: "start" });
    expect(state.status).toBe("listening");
    expect(effects).toEqual([]);
  });

  it("can start again after the cascade gave up", () => {
    const gone = live({ status: "unavailable", fellBack: true, ended: true });
    const { state } = reduce(gone, { type: "start" });
    expect(state).toMatchObject({ status: "connecting", fellBack: false, ended: false, reconnects: 0 });
  });

  it("speaks the question on screen as soon as the server says ready", () => {
    const { state, effects } = play([{ type: "start" }, ready()]);
    expect(state.status).toBe("listening");
    expect(effects).toEqual([{ type: "send", frame: { type: "speak_last" } }]);
  });

  it("starts the PCM worklet first when the server chose stream mode", () => {
    const { state, effects } = play([{ type: "start" }, ready({ mode: "stream", sampleRate: 16000 })]);
    expect(state.mode).toBe("stream");
    expect(effects[0]).toEqual({ type: "start_streaming", sampleRate: 16000 });
  });

  it("releases everything on end, and end is a no-op with no call", () => {
    expect(reduce(INITIAL_CALL, { type: "end" }).effects).toEqual([]);
    const { state, effects } = reduce(live(), { type: "end" });
    expect(state).toMatchObject({ status: "idle", ended: true });
    expect(types(effects)).toEqual(["teardown"]);
  });

  it("releases on unmount even when idle", () => {
    expect(types(reduce(INITIAL_CALL, { type: "unmount" }).effects)).toEqual(["teardown"]);
  });
});

describe("call state machine: a turn", () => {
  it("thinks after the interviewer's turn arrives, then speaks, then plays, then listens", () => {
    let s = live();
    s = play([frame({ type: "turn", message: { id: "m", role: "assistant", content: "Hi" } })], s).state;
    expect(s.status).toBe("thinking");
    const started = play([frame({ type: "speech_start", mime: "audio/ogg" })], s);
    expect(started.state.status).toBe("speaking");
    expect(types(started.effects)).toEqual(["end_utterance", "begin_speech", "reset_barge"]);
    const ended = play([frame({ type: "speech_end", interrupted: false })], started.state);
    expect(types(ended.effects)).toEqual(["play_speech"]);
    const done = reduce(ended.state, { type: "playback_finished" });
    expect(done.state.status).toBe("listening");
  });

  it("goes straight back to listening when the voice is gone and the text is all there is", () => {
    const s = live({ textOnly: true });
    const next = play([frame({ type: "turn", message: { id: "m", role: "assistant", content: "Hi" } })], s);
    expect(next.state.status).toBe("listening");
  });

  it("drops to text-only on a captions fallback and stops what is playing", () => {
    const next = play([frame({ type: "unavailable", reason: "no_tts_route", fallback: "captions" })], live());
    expect(next.state).toMatchObject({ textOnly: true, status: "listening" });
    expect(types(next.effects)).toEqual(["stop_playback", "reset_silence"]);
  });

  it("falls to text-only when the browser refuses to play", () => {
    const speaking = live({ status: "speaking" });
    const next = reduce(speaking, { type: "playback_refused" });
    expect(next.state).toMatchObject({ textOnly: true, status: "listening" });
  });

  it("discards an interrupted speech instead of playing it", () => {
    const next = play([frame({ type: "speech_end", interrupted: true })], live({ status: "speaking" }));
    expect(types(next.effects)).toEqual(["discard_speech", "reset_silence"]);
    expect(next.state.status).toBe("listening");
  });

  it("tells the caller what was heard, and holds on 'thinking' only from listening", () => {
    const heard = play([frame({ type: "caption_final", role: "user", text: "we print it" })], live());
    expect(heard.effects).toEqual([{ type: "heard", text: "we print it" }]);
    expect(heard.state.status).toBe("thinking");
    const mid = play(
      [frame({ type: "caption_final", role: "user", text: "again" })],
      live({ status: "speaking" }),
    );
    expect(mid.state.status).toBe("speaking");
  });

  it("does not echo the interviewer's own caption as something heard", () => {
    const next = play([frame({ type: "caption", role: "assistant", text: "Hi" })], live());
    expect(next.effects).toEqual([]);
  });

  it("clears the partial caption when the final one lands", () => {
    const s = play([frame({ type: "caption_partial", text: "we pri" })], live()).state;
    expect(s.partial).toBe("we pri");
    expect(play([frame({ type: "caption_final", role: "user", text: "we print" })], s).state.partial).toBe(
      "",
    );
  });
});

describe("call state machine: barge-in", () => {
  it("cuts the interviewer off locally and on the server, and optionally starts recording", () => {
    const speaking = live({ status: "speaking" });
    const keep = reduce(speaking, { type: "interrupt", keepTalking: true });
    expect(types(keep.effects)).toEqual(["stop_playback", "send", "reset_barge", "begin_utterance"]);
    expect(keep.effects[1]).toEqual({ type: "send", frame: { type: "barge" } });
    expect(keep.state.status).toBe("listening");
    expect(types(reduce(speaking, { type: "interrupt", keepTalking: false }).effects)).not.toContain(
      "begin_utterance",
    );
  });

  it("only interrupts while the interviewer is speaking", () => {
    expect(reduce(live({ status: "thinking" }), { type: "interrupt", keepTalking: true }).effects).toEqual(
      [],
    );
  });

  it("lets the server's own speech detection barge in, without a second barge frame", () => {
    const next = play([frame({ type: "speech_started", barged: true })], live({ status: "speaking" }));
    expect(types(next.effects)).toEqual(["stop_playback", "reset_barge"]);
    expect(next.state.status).toBe("listening");
  });

  it("sends the barge itself when the server did not", () => {
    const next = play([frame({ type: "speech_started", barged: false })], live({ status: "speaking" }));
    expect(next.effects.some((e) => e.type === "send")).toBe(true);
  });

  it("ignores the provider hearing speech when barge-in is off", () => {
    const next = play(
      [frame({ type: "speech_started", barged: true })],
      live({ status: "speaking", bargeIn: false }),
    );
    expect(next.state.status).toBe("speaking");
    expect(next.effects).toEqual([]);
  });
});

describe("call state machine: failure and the fallback chain", () => {
  it("hands over a fallback once, tears down, and reports it", () => {
    const next = play(
      [frame({ type: "unavailable", reason: "transcription_failed", fallback: "recorded" })],
      live(),
    );
    expect(next.state).toMatchObject({ status: "unavailable", fellBack: true, ended: true });
    expect(types(next.effects)).toEqual(["teardown", "unavailable"]);
    expect(reduce(next.state, frame({ type: "unavailable", reason: "x", fallback: "text" })).effects).toEqual(
      [],
    );
  });

  it("retries once after an unplanned drop, then gives the record button", () => {
    const first = reduce(live(), { type: "socket_closed" });
    expect(first.state).toMatchObject({ status: "connecting", reconnects: 1 });
    expect(types(first.effects)).toEqual(["drop_socket", "stop_playback", "end_utterance", "connect"]);
    const second = reduce(first.state, { type: "socket_closed" });
    expect(second.state.status).toBe("unavailable");
    expect(second.effects).toContainEqual({ type: "problem", problem: "lost" });
    expect(second.effects).toContainEqual({
      type: "unavailable",
      fallback: "recorded",
      reason: "connection_lost",
    });
  });

  it("does not read a close it asked for as a drop", () => {
    const ended = reduce(live(), { type: "end" }).state;
    expect(reduce(ended, { type: "socket_closed" }).effects).toEqual([]);
  });

  it("ends the call and pauses nothing further on an exhausted budget", () => {
    const next = play([frame({ type: "error", code: "budget_exceeded", message: "paused" })], live());
    expect(next.state.status).toBe("idle");
    expect(next.effects[0]).toEqual({ type: "error", code: "budget_exceeded", message: "paused" });
    expect(next.effects).toContainEqual({ type: "teardown" });
  });

  it("carries on listening after an ordinary error", () => {
    const next = play(
      [frame({ type: "error", code: "internal", message: "boom" })],
      live({ status: "thinking" }),
    );
    expect(next.state.status).toBe("listening");
  });

  it("asks for per-utterance capture when streaming is impossible here", () => {
    const next = reduce(live({ mode: "stream" }), { type: "capture_unavailable" });
    expect(next.state.mode).toBe("utterance");
    expect(next.effects).toEqual([
      { type: "stop_streaming" },
      { type: "send", frame: { type: "capture", mode: "utterance" } },
    ]);
  });

  it("acknowledges a server-initiated mode change", () => {
    const next = play(
      [frame({ type: "mode", mode: "utterance", reason: "stt_stream_failed" })],
      live({ mode: "stream" }),
    );
    expect(next.state.mode).toBe("utterance");
    expect(next.effects).toEqual([
      { type: "stop_streaming" },
      { type: "send", frame: { type: "capture", mode: "utterance" } },
    ]);
  });

  it("reports an utterance not heard and listens again", () => {
    const next = play([frame({ type: "not_heard" })], live({ status: "thinking" }));
    expect(next.state).toMatchObject({ notHeard: true, status: "listening", partial: "" });
  });
});

describe("speech detection", () => {
  const base: VadInput = {
    rms: 0,
    now: 0,
    status: "listening",
    mode: "utterance",
    bargeIn: true,
    recording: false,
    recordingMs: 0,
  };
  const step = (state: VadState, over: Partial<VadInput>) => vadStep(state, { ...base, ...over });

  it("maps loudness to the meter's steps", () => {
    expect(meterStep(0)).toBe(0);
    expect(meterStep(10)).toBe(METER_STEPS);
    expect(meterStep(0.15)).toBe(METER_STEPS / 2);
  });

  it("starts recording at the speech threshold and not below it", () => {
    expect(step(INITIAL_VAD, { rms: SPEECH_RMS }).action).toEqual({ type: "begin_utterance" });
    expect(step(INITIAL_VAD, { rms: SPEECH_RMS - 0.001 }).action).toEqual({ type: "none" });
  });

  it("ends the utterance after the silence window, counted from the first quiet poll", () => {
    let s = INITIAL_VAD;
    let r = step(s, { recording: true, rms: 0, now: 1000 });
    expect(r.action).toEqual({ type: "none" });
    s = r.state;
    r = step(s, { recording: true, rms: 0, now: 1000 + SILENCE_MS - 1 });
    expect(r.action).toEqual({ type: "none" });
    r = step(r.state, { recording: true, rms: 0, now: 1000 + SILENCE_MS });
    expect(r.action).toEqual({ type: "end_utterance" });
    expect(r.state.silenceSince).toBeNull();
  });

  it("restarts the quiet clock when speech resumes", () => {
    let r = step(INITIAL_VAD, { recording: true, rms: 0, now: 100 });
    r = step(r.state, { recording: true, rms: SPEECH_RMS, now: 500 });
    expect(r.state.silenceSince).toBeNull();
    r = step(r.state, { recording: true, rms: 0, now: 600 });
    expect(r.state.silenceSince).toBe(600);
  });

  it("never records in a quiet room", () => {
    expect(step(INITIAL_VAD, { rms: 0.01, now: 99999 }).action).toEqual({ type: "none" });
  });

  it("cuts a recording that never sees silence", () => {
    const r = step(INITIAL_VAD, { recording: true, recordingMs: MAX_UTTERANCE_MS, rms: SPEECH_RMS * 2 });
    expect(r.action).toEqual({ type: "end_utterance" });
  });

  it("needs a held, clear signal to interrupt, and a cough does not", () => {
    let s: VadState = INITIAL_VAD;
    for (let i = 0; i < BARGE_POLLS - 1; i++) {
      const r = step(s, { status: "speaking", rms: BARGE_RMS });
      expect(r.action).toEqual({ type: "none" });
      s = r.state;
    }
    const cough = step(s, { status: "speaking", rms: 0.01 });
    expect(cough.state.loudPolls).toBe(0);
    let held: VadState = INITIAL_VAD;
    let action: { type: string } = { type: "none" };
    for (let i = 0; i < BARGE_POLLS; i++) {
      const r = step(held, { status: "speaking", rms: BARGE_RMS });
      held = r.state;
      action = r.action;
    }
    expect(action).toEqual({ type: "interrupt", keepTalking: true });
  });

  it("does not start a recording on an interrupt in stream mode: the audio is already flowing", () => {
    let s: VadState = INITIAL_VAD;
    let action: { type: string; keepTalking?: boolean } = { type: "none" };
    for (let i = 0; i < BARGE_POLLS; i++) {
      const r = step(s, { status: "speaking", mode: "stream", rms: BARGE_RMS });
      s = r.state;
      action = r.action;
    }
    expect(action).toEqual({ type: "interrupt", keepTalking: false });
  });

  it("leaves the interviewer alone when barge-in is off", () => {
    expect(step(INITIAL_VAD, { status: "speaking", bargeIn: false, rms: 1 }).action).toEqual({
      type: "none",
    });
  });

  it("does not detect the end of speech in stream mode: the provider does", () => {
    const r = step(INITIAL_VAD, { mode: "stream", recording: true, rms: 0, now: 99999 });
    expect(r.action).toEqual({ type: "none" });
  });

  it("does nothing while there is no call", () => {
    for (const status of ["idle", "connecting", "unavailable"] as const) {
      expect(step(INITIAL_VAD, { status, rms: 1 }).action).toEqual({ type: "none" });
    }
  });
});

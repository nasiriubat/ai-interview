"use client";

import * as React from "react";
import { Capture } from "./live-voice/capture";
import { INITIAL_CALL, reduce, type CallEffect, type CallEvent, type CallState } from "./live-voice/machine";
import { Player } from "./live-voice/playback";
import { LiveSocket } from "./live-voice/socket";
import type { LiveVoiceCallbacks, LiveVoiceController, LiveVoiceProblem } from "./live-voice/types";
import { INITIAL_VAD, meterStep, METER_STEPS, POLL_MS, vadStep } from "./live-voice/vad";
import { microphoneProblem } from "./useRecorder";

/**
 * The browser half of the real-time voice cascade (FR-30a).
 *
 * This hook is the glue. The decisions are in `live-voice/machine.ts` (a pure reducer: what each
 * server frame, drop or playback event does to the call, and which effects it asks for) and
 * `live-voice/vad.ts` (a pure function from loudness to "start recording", "stop", "interrupt").
 * The browser objects are behind three small classes: `Capture` (microphone, analyser, recorder,
 * PCM worklet), `Player` (the interviewer's voice) and `LiveSocket`. The hook owns one of each,
 * feeds events to the reducer, and executes the effects it returns.
 *
 * Three decisions shape it.
 *
 * **Two ways to hear, and the server picks (D-77).** Its `ready` frame names the mode.
 *
 * - `stream`: an AudioWorklet turns the microphone into PCM16 at 24 kHz and sends it in 80 ms
 *   frames for as long as the call lasts. The server's provider transcribes while the participant
 *   talks, the growing text comes back as `caption_partial`, and the provider decides when they
 *   have finished. Nothing here detects the end of speech.
 * - `utterance`: one recording per utterance (D-70). The server treats everything sent since the
 *   last `utterance` frame as a complete `audio/webm` file, so the recorder is started when the
 *   participant starts talking and stopped when they stop.
 *
 * Either way the analyser runs continuously, for the meter and for barge-in. A server that loses
 * its streaming provider mid-call sends `mode: utterance`, and the call carries on with
 * recordings; a browser without AudioWorklet asks for that itself.
 *
 * **Playback is buffered, not incremental** (see `Player`).
 *
 * **Every exit releases the microphone.** End, unmount, a fallback, a refused permission, a lost
 * socket: all of them are a `teardown` effect. A voice product that leaves the light on is a
 * privacy bug, not a leaked object.
 */

export { METER_STEPS };
export type {
  LiveVoiceCallbacks,
  LiveVoiceController,
  LiveVoiceProblem,
  LiveVoiceStatus,
} from "./live-voice/types";

interface Live {
  socket: LiveSocket;
  capture: Capture;
  player: Player;
  poll: ReturnType<typeof setInterval> | null;
  vad: typeof INITIAL_VAD;
  step: number;
}

export function useLiveVoice(callbacks: LiveVoiceCallbacks): LiveVoiceController {
  const cb = React.useRef(callbacks);
  cb.current = callbacks;

  // `view` is what renders; `machine` is what the socket handlers and the polling loop read. Both
  // outlive the render that created them, so reading state there would read whatever it was at
  // connect time. The reducer runs against the ref, synchronously, and the result is mirrored.
  const [view, setView] = React.useState<CallState>(INITIAL_CALL);
  const [level, setLevel] = React.useState(0);
  const [problem, setProblem] = React.useState<LiveVoiceProblem | null>(null);
  const machine = React.useRef<CallState>(INITIAL_CALL);
  const liveRef = React.useRef<Live | null>(null);
  liveRef.current ??= {
    socket: new LiveSocket(),
    capture: new Capture(),
    player: new Player(),
    poll: null,
    vad: INITIAL_VAD,
    step: 0,
  };
  const live = liveRef.current;

  const dispatch = (event: CallEvent): void => {
    const { state, effects } = reduce(machine.current, event);
    machine.current = state;
    setView(state);
    for (const effect of effects) run(effect);
  };

  /** Releases the microphone, the player and the polling loop. */
  const release = (): void => {
    live.capture.release();
    live.player.stop();
    if (live.poll !== null) {
      clearInterval(live.poll);
      live.poll = null;
    }
    live.step = 0;
    setLevel(0);
  };

  const beginUtterance = (): void => {
    const started = live.capture.beginUtterance({
      onData: (audio) => {
        live.socket.sendBytes(audio);
      },
      onStop: (durationMs) => {
        dispatch({ type: "utterance_stopped", durationMs });
      },
      onError: () => {
        dispatch({ type: "recorder_failed" });
      },
    });
    if (started === "busy") return;
    if (started === "failed") {
      setProblem("failed");
      return;
    }
    live.vad = { ...live.vad, silenceSince: null };
    dispatch({ type: "utterance_started" });
  };

  const endUtterance = (): void => {
    if (!live.capture.recording) return;
    live.vad = { ...live.vad, silenceSince: null };
    live.capture.endUtterance();
  };

  /**
   * Stream mode. While the interviewer is talking with barge-in off, frames are not sent: nothing
   * the participant says then can interrupt, and the speakers leaking into the microphone would
   * otherwise be transcribed as their answer. With barge-in on they are sent, because the
   * provider's own speech detection is the second half of barge-in; echo cancellation keeps the
   * interviewer's voice out of them.
   */
  const startStreaming = async (sampleRate: number): Promise<void> => {
    const ok = await live.capture.startStreaming(
      sampleRate,
      (frame) => {
        const s = machine.current;
        if (s.mode !== "stream") return;
        if (s.status === "idle" || s.status === "connecting" || s.status === "unavailable") return;
        if (s.status === "speaking" && !s.bargeIn) return;
        // A muted microphone is silence; there is nothing worth sending the provider.
        if (s.muted) return;
        live.socket.sendBytes(frame);
      },
      () => machine.current.mode === "stream",
    );
    // No AudioWorklet (an old browser), or it failed to load: record per utterance instead.
    if (!ok) dispatch({ type: "capture_unavailable" });
  };

  const connect = (): void => {
    const opened = live.socket.open({
      onFrame: (frame) => {
        dispatch({ type: "frame", frame });
      },
      onAudio: (data) => {
        live.player.push(data);
      },
      onClose: () => {
        dispatch({ type: "socket_closed" });
      },
    });
    if (!opened) dispatch({ type: "socket_failed" });
  };

  const tick = (): void => {
    const now = Date.now();
    const rms = live.capture.measure();
    // Quantized, and only published when the step changes: a meter that re-renders the whole
    // interview twenty times a second is a cost nobody asked for.
    const step = meterStep(rms);
    if (step !== live.step) {
      live.step = step;
      setLevel(step / METER_STEPS);
    }
    const s = machine.current;
    const { state, action } = vadStep(live.vad, {
      rms,
      now,
      status: s.status,
      mode: s.mode,
      bargeIn: s.bargeIn,
      recording: live.capture.recording,
      recordingMs: live.capture.recordingMs(now),
    });
    live.vad = state;
    switch (action.type) {
      case "begin_utterance":
        beginUtterance();
        return;
      case "end_utterance":
        endUtterance();
        return;
      case "interrupt":
        // In stream mode the audio is already on its way; there is no recording to start.
        dispatch({ type: "interrupt", keepTalking: action.keepTalking });
        return;
      case "none":
        return;
    }
  };

  const open = async (): Promise<void> => {
    if (!Capture.capable()) {
      setProblem("unsupported");
      dispatch({ type: "open_failed" });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await Capture.requestMicrophone();
    } catch (e) {
      setProblem(microphoneProblem(e));
      dispatch({ type: "open_failed" });
      return;
    }
    if (machine.current.ended) {
      // They gave up while the permission prompt was open. Do not keep the device.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    try {
      live.capture.attach(stream);
    } catch {
      release();
      setProblem("failed");
      dispatch({ type: "open_failed" });
      return;
    }
    live.poll = setInterval(tick, POLL_MS);
    connect();
  };

  function run(effect: CallEffect): void {
    switch (effect.type) {
      case "send":
        live.socket.send(effect.frame);
        return;
      case "open_devices":
        void open();
        return;
      case "connect":
        connect();
        return;
      case "drop_socket":
        live.socket.forget();
        return;
      case "teardown":
        live.socket.close();
        release();
        return;
      case "start_streaming":
        void startStreaming(effect.sampleRate);
        return;
      case "stop_streaming":
        live.capture.stopStreaming();
        return;
      case "set_muted":
        live.capture.setMuted(effect.muted);
        return;
      case "stop_playback":
        live.player.stop();
        return;
      case "begin_speech":
        live.player.begin(effect.mime);
        return;
      case "discard_speech":
        live.player.discard();
        return;
      case "play_speech":
        live.player.play(
          () => {
            dispatch({ type: "playback_finished" });
          },
          () => {
            dispatch({ type: "playback_refused" });
          },
          effect.more,
        );
        return;
      case "begin_utterance":
        beginUtterance();
        return;
      case "end_utterance":
        endUtterance();
        return;
      case "reset_barge":
        live.vad = { ...live.vad, loudPolls: 0 };
        return;
      case "reset_silence":
        live.vad = { ...live.vad, silenceSince: null };
        return;
      case "clear_problem":
        setProblem(null);
        return;
      case "problem":
        setProblem(effect.problem);
        return;
      case "turn":
        cb.current.onTurn(effect.frame);
        return;
      case "heard":
        cb.current.onHeard(effect.text);
        return;
      case "ended":
        cb.current.onEnded(effect.summaryAvailable);
        return;
      case "error":
        cb.current.onError(effect.code, effect.message);
        return;
      case "unavailable":
        cb.current.onUnavailable(effect.fallback, effect.reason);
        return;
    }
  }

  // The unmount path has to reach the dispatch of the render that is actually live, and an effect
  // with `[]` would capture the first one.
  const dispatchRef = React.useRef(dispatch);
  dispatchRef.current = dispatch;
  React.useEffect(() => {
    return () => {
      dispatchRef.current({ type: "unmount" });
    };
  }, []);

  return {
    status: view.status,
    level,
    captions: view.captions,
    textOnly: view.textOnly,
    notHeard: view.notHeard,
    partial: view.partial,
    mode: view.mode,
    muted: view.muted,
    problem,
    start: () => {
      dispatch({ type: "start" });
    },
    end: () => {
      dispatch({ type: "end" });
    },
    setMuted: (muted) => {
      dispatch({ type: "mute", muted });
    },
    stopSpeaking: () => {
      // Always available, even where the tenant turned automatic barge-in off: a visible way to
      // stop the interviewer talking is an accessibility requirement, not a voice feature.
      dispatch({ type: "interrupt", keepTalking: false });
    },
    dismissProblem: () => {
      setProblem(null);
    },
  };
}

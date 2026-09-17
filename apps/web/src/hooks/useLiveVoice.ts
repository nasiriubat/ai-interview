"use client";

import * as React from "react";
import { microphoneProblem, recorderOptions, type RecorderProblem } from "./useRecorder";
import {
  toServerFrame,
  type ClientFrame,
  type ServerFrame,
  type TurnFrame,
  type VoiceFallback,
} from "@/lib/api/voice-live";
import { voiceSocketUrl } from "@/lib/env";

/**
 * The browser half of the real-time voice cascade (FR-30a).
 *
 * The socket, the microphone, the end-of-utterance detector and playback, behind one state
 * machine. Three decisions shape it.
 *
 * **One recording per utterance, not one continuous stream.** The server treats everything sent
 * since the last `utterance` frame as a complete `audio/webm` file and hands it to the
 * transcription route. A webm stream cut at an arbitrary point is not a file: only the first piece
 * carries the container header. So the `MediaRecorder` is started when the participant starts
 * talking and stopped when they stop, and the audio in between goes out in 250 ms slices. The
 * analyser runs continuously on the `MediaStream` instead, which is what makes it hands-free.
 *
 * **Playback is buffered, not incremental.** The audio of one `speech_start`/`speech_end` pair is
 * collected into a Blob and played from an object URL, so speech begins when the server has
 * finished synthesizing rather than when the first byte lands. `MediaSource` would start sooner,
 * but it needs codec-exact `SourceBuffer` mime strings, is absent from Safari on iPhone, and a
 * mismatch there fails silently — an interviewer that says nothing at all is a worse bug than an
 * interviewer that starts a moment late. The server measures `first_word` from its own side, so
 * the spec's latency number is still honest; this is the extra the browser adds.
 *
 * **Every exit releases the microphone.** End, unmount, a fallback, a refused permission, a lost
 * socket: all of them go through `release`. A voice product that leaves the light on is a privacy
 * bug, not a leaked object.
 */

/** `WebSocket.OPEN`, spelled out so the hook does not depend on a global that tests replace. */
const SOCKET_OPEN = 1;

/** Small enough that audio is on the wire while the participant is still talking. */
const CHUNK_MS = 250;

/** How often the analyser is read: fine enough to resolve the silence window, cheap enough to ignore. */
const POLL_MS = 50;

/** End of utterance: this much quiet after something was actually said. */
const SILENCE_MS = 900;

/** Root-mean-square above which the microphone is carrying speech rather than room noise. */
const SPEECH_RMS = 0.045;

/**
 * Interrupting takes a clearer signal than starting to talk into silence, and it has to hold for a
 * few polls: the speakers are feeding the microphone, and a cough must not cut the interviewer off.
 */
const BARGE_RMS = 0.09;
const BARGE_POLLS = 3;

/** The loudness that fills the level meter. Normal speech sits well below it. */
const FULL_SCALE_RMS = 0.3;

/** The meter is drawn in steps, and the level only re-renders when the step changes. */
export const METER_STEPS = 8;

/** A detector that never sees silence must not record for ever; the server caps the bytes anyway. */
const MAX_UTTERANCE_MS = 2 * 60 * 1000;

const ANALYSER_FFT = 1024;

export type LiveVoiceStatus = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "unavailable";

/** The recorder's problems plus the one only a live call has: the socket went away for good. */
export type LiveVoiceProblem = RecorderProblem | "lost";

export interface LiveVoiceCallbacks {
  /** One interviewer turn — the same payload the SSE stream carries, so it becomes a normal message. */
  onTurn: (turn: TurnFrame) => void;
  /**
   * What the participant was heard to say. This is the only way their own words reach the browser:
   * the server takes the turn with the answer already transcribed, so no `turn` frame echoes it.
   */
  onHeard: (text: string) => void;
  onEnded: (summaryAvailable: boolean) => void;
  /** A turn that failed, in the same shape the interview's own error alert takes. */
  onError: (code: string, message: string) => void;
  /**
   * The call is over because the cascade cannot hear, and this is the rung of spec 09's chain that
   * is still standing: `recorded` when transcription merely failed, `text` when there is no
   * transcription route at all and the microphone would fail the same way.
   *
   * The hook does not decide what to offer instead — it has already released the device and closed
   * the socket. `reason` is the server's word for why, for logs and for wording.
   */
  onUnavailable: (fallback: Exclude<VoiceFallback, "captions">, reason: string) => void;
}

export interface LiveVoiceController {
  status: LiveVoiceStatus;
  /** Microphone loudness, 0 to 1, quantized to the meter's steps. */
  level: number;
  /** Whether the server sends captions. When it does not, nothing the participant says is shown. */
  captions: boolean;
  /** The server's voice is gone; the call carries on in text (the middle rung of the chain). */
  textOnly: boolean;
  /** The last utterance transcribed to nothing, so the participant can be asked to try again. */
  notHeard: boolean;
  problem: LiveVoiceProblem | null;
  start: () => void;
  end: () => void;
  /** Cuts the interviewer off now: the same thing barge-in does, from a button. */
  stopSpeaking: () => void;
  dismissProblem: () => void;
}

export function useLiveVoice(callbacks: LiveVoiceCallbacks): LiveVoiceController {
  const cb = React.useRef(callbacks);
  cb.current = callbacks;

  const [status, setStatus] = React.useState<LiveVoiceStatus>("idle");
  const [level, setLevel] = React.useState(0);
  const [captions, setCaptions] = React.useState(false);
  const [textOnly, setTextOnly] = React.useState(false);
  const [notHeard, setNotHeard] = React.useState(false);
  const [problem, setProblem] = React.useState<LiveVoiceProblem | null>(null);

  // Everything the polling loop and the socket handlers touch lives in a ref: both outlive the
  // render that created them, so reading state there would read whatever it was at connect time.
  const statusRef = React.useRef<LiveVoiceStatus>("idle");
  const socketRef = React.useRef<WebSocket | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const contextRef = React.useRef<AudioContext | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const samplesRef = React.useRef<Uint8Array<ArrayBuffer> | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const startedAtRef = React.useRef(0);
  const silenceSinceRef = React.useRef<number | null>(null);
  const loudPollsRef = React.useRef(0);
  const stepRef = React.useRef(0);
  const playerRef = React.useRef<HTMLAudioElement | null>(null);
  const speechRef = React.useRef<{ mime: string; chunks: Blob[] } | null>(null);
  const objectUrlRef = React.useRef<string | null>(null);
  const bargeInRef = React.useRef(false);
  const textOnlyRef = React.useRef(false);
  const reconnectsRef = React.useRef(0);
  /** The call was ended on purpose, so a closing socket is not a failure. */
  const endedRef = React.useRef(false);
  const fellBackRef = React.useRef(false);

  const setPhase = (next: LiveVoiceStatus): void => {
    statusRef.current = next;
    setStatus(next);
  };

  const send = (frame: ClientFrame): void => {
    const socket = socketRef.current;
    if (socket?.readyState === SOCKET_OPEN) socket.send(JSON.stringify(frame));
  };

  /** Blobs go over the socket as they are, so audio and the frame that closes it keep their order. */
  const sendAudio = (audio: Blob): void => {
    const socket = socketRef.current;
    if (socket?.readyState === SOCKET_OPEN) socket.send(audio);
  };

  const stopPlayback = (): void => {
    const player = playerRef.current;
    if (player) {
      player.onended = null;
      player.onerror = null;
      player.pause();
      player.removeAttribute("src");
    }
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    speechRef.current = null;
  };

  const release = (): void => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    stopPlayback();
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    analyserRef.current = null;
    samplesRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    context?.close().catch(() => undefined);
    stepRef.current = 0;
    setLevel(0);
  };

  const teardown = (next: LiveVoiceStatus): void => {
    endedRef.current = true;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      // Silenced first: a socket closed on purpose must not look like one that dropped.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify({ type: "bye" }));
      socket.close();
    }
    release();
    setPhase(next);
  };

  const giveUp = (fallback: Exclude<VoiceFallback, "captions">, reason: string): void => {
    if (fellBackRef.current) return;
    fellBackRef.current = true;
    teardown("unavailable");
    cb.current.onUnavailable(fallback, reason);
  };

  const toListening = (): void => {
    if (statusRef.current === "idle" || statusRef.current === "unavailable") return;
    silenceSinceRef.current = null;
    setPhase("listening");
  };

  const beginUtterance = (): void => {
    const stream = streamRef.current;
    if (recorderRef.current || !stream) return;
    let recorder: MediaRecorder;
    try {
      recorder = new window.MediaRecorder(stream, recorderOptions());
    } catch {
      setProblem("failed");
      return;
    }
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    silenceSinceRef.current = null;
    setNotHeard(false);
    recorder.ondataavailable = (e: BlobEvent): void => {
      if (e.data.size > 0) sendAudio(e.data);
    };
    recorder.onerror = (): void => {
      recorderRef.current = null;
      // The audio already on the server is half an answer; better discarded than transcribed.
      send({ type: "cancel" });
      setProblem("failed");
      toListening();
    };
    recorder.onstop = (): void => {
      const durationMs = Date.now() - startedAtRef.current;
      recorderRef.current = null;
      send({ type: "utterance", durationMs });
      // Answering may take a few seconds; say so rather than leaving "listening" on screen.
      if (statusRef.current === "listening") setPhase("thinking");
    };
    recorder.start(CHUNK_MS);
  };

  const endUtterance = (): void => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    silenceSinceRef.current = null;
    if (recorder.state === "inactive") {
      recorderRef.current = null;
      return;
    }
    recorder.stop();
  };

  /** Stops the interviewer talking, locally and on the server. */
  const interrupt = (keepTalking: boolean): void => {
    if (statusRef.current !== "speaking") return;
    stopPlayback();
    send({ type: "barge" });
    loudPollsRef.current = 0;
    setPhase("listening");
    if (keepTalking) beginUtterance();
  };

  const play = (): void => {
    const speech = speechRef.current;
    speechRef.current = null;
    if (!speech || speech.chunks.length === 0) {
      toListening();
      return;
    }
    const player = (playerRef.current ??= new Audio());
    const url = URL.createObjectURL(new Blob(speech.chunks, { type: speech.mime }));
    objectUrlRef.current = url;
    const done = (): void => {
      if (objectUrlRef.current === url) {
        URL.revokeObjectURL(url);
        objectUrlRef.current = null;
      }
      toListening();
    };
    player.onended = done;
    player.onerror = done;
    player.src = url;
    player.play().catch(() => {
      // Autoplay refused, or a container this browser cannot decode. The text is already on
      // screen, so the call carries on without the voice rather than stopping.
      textOnlyRef.current = true;
      setTextOnly(true);
      done();
    });
  };

  const measure = (): number => {
    const analyser = analyserRef.current;
    const samples = samplesRef.current;
    if (!analyser || !samples) return 0;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const centred = (sample - 128) / 128;
      sum += centred * centred;
    }
    return Math.sqrt(sum / samples.length);
  };

  const tick = (): void => {
    const rms = measure();
    // Quantized, and only published when the step changes: a meter that re-renders the whole
    // interview twenty times a second is a cost nobody asked for.
    const step = Math.min(METER_STEPS, Math.round((rms / FULL_SCALE_RMS) * METER_STEPS));
    if (step !== stepRef.current) {
      stepRef.current = step;
      setLevel(step / METER_STEPS);
    }

    const phase = statusRef.current;
    if (phase === "idle" || phase === "connecting" || phase === "unavailable") return;

    if (phase === "speaking") {
      if (!bargeInRef.current) return;
      loudPollsRef.current = rms >= BARGE_RMS ? loudPollsRef.current + 1 : 0;
      if (loudPollsRef.current >= BARGE_POLLS) interrupt(true);
      return;
    }

    // Listening, or thinking: an answer given while the turn is still running is the ordinary
    // case, not an error, and the server holds it until the turn in flight is done.
    if (recorderRef.current && Date.now() - startedAtRef.current >= MAX_UTTERANCE_MS) {
      endUtterance();
      return;
    }
    if (rms >= SPEECH_RMS) {
      silenceSinceRef.current = null;
      beginUtterance();
      return;
    }
    // Nothing was ever above the threshold, so there is nothing to send: this is what keeps a
    // quiet room from asking the interviewer a question every second.
    if (!recorderRef.current) return;
    const now = Date.now();
    silenceSinceRef.current ??= now;
    if (now - silenceSinceRef.current >= SILENCE_MS) endUtterance();
  };

  const onFrame = (frame: ServerFrame): void => {
    switch (frame.type) {
      case "ready":
        reconnectsRef.current = 0;
        bargeInRef.current = frame.bargeIn;
        setCaptions(frame.captions);
        setPhase("listening");
        // Say the question that is already on screen, so somebody who switches to voice halfway
        // through hears where they are instead of silence. It takes no turn and stores nothing,
        // and it opens the interview when nothing has been asked yet, so it is unconditional —
        // including after a reconnect, where it re-reads the question the drop interrupted.
        send({ type: "speak_last" });
        return;
      case "turn":
        cb.current.onTurn(frame);
        // With no voice coming, the turn is over the moment the text arrives.
        setPhase(textOnlyRef.current ? "listening" : "thinking");
        return;
      case "caption":
        // The interviewer's caption repeats the `turn` frame that came immediately before it;
        // rendering both would put every exchange in the list twice.
        if (frame.role === "user") cb.current.onHeard(frame.text);
        return;
      case "speech_start":
        // An utterance still open when the interviewer starts talking is closed here rather than
        // left running: the silence detector is paused while the speakers are on, so it would go
        // on recording the interviewer's own voice into the participant's next answer. The server
        // holds what it receives and answers it once this turn is done.
        endUtterance();
        speechRef.current = { mime: frame.mime, chunks: [] };
        loudPollsRef.current = 0;
        setPhase("speaking");
        return;
      case "speech_end":
        if (frame.interrupted) {
          speechRef.current = null;
          toListening();
          return;
        }
        play();
        return;
      case "first_word":
        // The server already folds this into the session's `voice.live` event, which is where the
        // spec asks for it. Showing a participant their own latency would only make them watch it.
        return;
      case "not_heard":
        setNotHeard(true);
        toListening();
        return;
      case "ended":
        cb.current.onEnded(frame.summaryAvailable);
        teardown("idle");
        return;
      case "error":
        cb.current.onError(frame.code, frame.message);
        // An exhausted budget pauses the session server-side; carrying on listening would only
        // collect answers nothing will read.
        if (frame.code === "budget_exceeded") teardown("idle");
        else toListening();
        return;
      case "unavailable":
        if (frame.fallback === "captions") {
          textOnlyRef.current = true;
          setTextOnly(true);
          stopPlayback();
          toListening();
          return;
        }
        giveUp(frame.fallback, frame.reason);
        return;
    }
  };

  const onClose = (): void => {
    if (endedRef.current || fellBackRef.current) return;
    socketRef.current = null;
    stopPlayback();
    endUtterance();
    if (reconnectsRef.current === 0) {
      // One retry. A socket that drops mid-answer is usually a blip, and nothing is lost by
      // reopening: every turn so far is already persisted. Twice means it is not coming back.
      reconnectsRef.current = 1;
      setPhase("connecting");
      connect();
      return;
    }
    setProblem("lost");
    // The socket, not the cascade: the transcription route is presumably fine, so the record
    // button is worth offering.
    giveUp("recorded", "connection_lost");
  };

  function connect(): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(voiceSocketUrl());
    } catch {
      giveUp("recorded", "socket_failed");
      return;
    }
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onmessage = (e: MessageEvent<unknown>): void => {
      if (typeof e.data === "string") {
        const frame = toServerFrame(e.data);
        if (frame) onFrame(frame);
        return;
      }
      // Binary: audio belonging to the speech currently in flight, and nothing else.
      const speech = speechRef.current;
      if (!speech) return;
      const data = e.data;
      if (data instanceof Blob) speech.chunks.push(data);
      else if (data instanceof ArrayBuffer) speech.chunks.push(new Blob([data]));
      else if (ArrayBuffer.isView(data)) speech.chunks.push(new Blob([data.buffer as ArrayBuffer]));
    };
    socket.onclose = (): void => {
      onClose();
    };
    // A socket error is always followed by a close, which is where the retry lives.
    socket.onerror = (): void => undefined;
  }

  const open = async (): Promise<void> => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    const capable =
      media?.getUserMedia &&
      typeof window.MediaRecorder !== "undefined" &&
      typeof window.AudioContext !== "undefined" &&
      typeof window.WebSocket !== "undefined";
    if (!capable) {
      setProblem("unsupported");
      setPhase("idle");
      return;
    }

    let stream: MediaStream;
    try {
      // Echo cancellation is not a nicety here: without it the interviewer's own voice comes back
      // through the microphone and barge-in fires on every sentence it speaks.
      stream = await media.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      setProblem(microphoneProblem(e));
      setPhase("idle");
      return;
    }
    if (endedRef.current) {
      // They gave up while the permission prompt was open. Do not keep the device.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    streamRef.current = stream;

    try {
      const context = new window.AudioContext();
      contextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = ANALYSER_FFT;
      context.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;
      samplesRef.current = new Uint8Array(analyser.fftSize);
    } catch {
      release();
      setProblem("failed");
      setPhase("idle");
      return;
    }

    pollRef.current = setInterval(tick, POLL_MS);
    connect();
  };

  const start = (): void => {
    if (statusRef.current !== "idle" && statusRef.current !== "unavailable") return;
    endedRef.current = false;
    fellBackRef.current = false;
    reconnectsRef.current = 0;
    textOnlyRef.current = false;
    setTextOnly(false);
    setProblem(null);
    setNotHeard(false);
    setPhase("connecting");
    void open();
  };

  const end = (): void => {
    if (statusRef.current === "idle") return;
    teardown("idle");
  };

  // The unmount path has to reach the teardown of the render that is actually live, and an effect
  // with `[]` would capture the first one.
  const teardownRef = React.useRef(teardown);
  teardownRef.current = teardown;
  React.useEffect(() => {
    return () => {
      teardownRef.current("idle");
    };
  }, []);

  return {
    status,
    level,
    captions,
    textOnly,
    notHeard,
    problem,
    start,
    end,
    stopSpeaking: () => {
      // Always available, even where the tenant turned automatic barge-in off: a visible way to
      // stop the interviewer talking is an accessibility requirement, not a voice feature.
      interrupt(false);
    },
    dismissProblem: () => {
      setProblem(null);
    },
  };
}

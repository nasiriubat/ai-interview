import { recorderOptions } from "../useRecorder";
import { PCM_FRAME_MS, PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from "@/lib/voice/pcm-worklet";

/** Small enough that audio is on the wire while the participant is still talking. */
const CHUNK_MS = 250;

const ANALYSER_FFT = 1024;

export interface UtteranceHandlers {
  onData: (audio: Blob) => void;
  onStop: (durationMs: number) => void;
  onError: () => void;
}

/**
 * The microphone and everything built on it: the analyser that feeds the meter and barge-in, the
 * recorder that cuts one utterance at a time, and the PCM worklet for stream mode.
 *
 * It owns the device. `release` is the only exit, and every path out of a call goes through it: a
 * voice product that leaves the light on is a privacy bug, not a leaked object.
 */
export class Capture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recordingStartedAt = 0;

  /** Whether this browser has everything a live call needs. */
  static capable(): boolean {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    return Boolean(
      media?.getUserMedia &&
      typeof window.MediaRecorder !== "undefined" &&
      typeof window.AudioContext !== "undefined" &&
      typeof window.WebSocket !== "undefined",
    );
  }

  /**
   * Asks for the microphone. Echo cancellation is not a nicety here: without it the interviewer's
   * own voice comes back through the microphone and barge-in fires on every sentence it speaks.
   */
  static requestMicrophone(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  /** Takes the stream and builds the analyser on it. Throws when the audio graph cannot be built. */
  attach(stream: MediaStream): void {
    this.stream = stream;
    const context = new window.AudioContext();
    this.context = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = ANALYSER_FFT;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    this.source = source;
    this.analyser = analyser;
    this.samples = new Uint8Array(analyser.fftSize);
  }

  /**
   * Mutes by disabling the microphone's tracks: the device stays open (so unmuting is instant and
   * the permission is not asked for again) and what the analyser, the recorder and the worklet
   * receive is silence. Mute is the participant's choice, so it is never left on by accident:
   * `release` ends the stream and a new call starts unmuted.
   */
  setMuted(muted: boolean): void {
    for (const track of this.stream?.getTracks() ?? []) track.enabled = !muted;
  }

  /** Whether a recording is open, and how long it has run. */
  get recording(): boolean {
    return this.recorder !== null;
  }

  recordingMs(now: number): number {
    return now - this.recordingStartedAt;
  }

  /** Root-mean-square loudness of the microphone right now, 0 to 1. */
  measure(): number {
    const { analyser, samples } = this;
    if (!analyser || !samples) return 0;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const centred = (sample - 128) / 128;
      sum += centred * centred;
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Starts recording one utterance. `failed` when the recorder cannot be built, which the caller
   * reports; `busy` when one is already open.
   *
   * A webm stream cut at an arbitrary point is not a file: only the first piece carries the
   * container header. So the recorder is started when the participant starts talking and stopped
   * when they stop, and the audio in between goes out in 250 ms slices.
   */
  beginUtterance(handlers: UtteranceHandlers): "started" | "busy" | "failed" {
    const { stream } = this;
    if (this.recorder || !stream) return "busy";
    let recorder: MediaRecorder;
    try {
      recorder = new window.MediaRecorder(stream, recorderOptions());
    } catch {
      return "failed";
    }
    this.recorder = recorder;
    this.recordingStartedAt = Date.now();
    recorder.ondataavailable = (e: BlobEvent): void => {
      if (e.data.size > 0) handlers.onData(e.data);
    };
    recorder.onerror = (): void => {
      this.recorder = null;
      handlers.onError();
    };
    recorder.onstop = (): void => {
      const durationMs = Date.now() - this.recordingStartedAt;
      this.recorder = null;
      handlers.onStop(durationMs);
    };
    recorder.start(CHUNK_MS);
    return "started";
  }

  /** Stops the open recording, if any; its `onStop` sends the utterance. */
  endUtterance(): void {
    const { recorder } = this;
    if (!recorder) return;
    if (recorder.state === "inactive") {
      this.recorder = null;
      return;
    }
    recorder.stop();
  }

  /**
   * Stream mode: routes the microphone through the PCM worklet and calls `onFrame` with each
   * frame as it is made. Resolves false when that is impossible (no AudioWorklet, or it failed to
   * load), which means "record per utterance instead".
   *
   * `stillWanted` is asked after the module loads: the call may have moved on while it did.
   */
  async startStreaming(
    sampleRate: number,
    onFrame: (frame: ArrayBuffer) => void,
    stillWanted: () => boolean,
  ): Promise<boolean> {
    const { context, source } = this;
    if (!context || !source || typeof context.audioWorklet === "undefined") {
      this.stopStreaming();
      return false;
    }
    const url = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
      if (this.context !== context || !stillWanted()) return true;
      const node = new AudioWorkletNode(context, PCM_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { targetRate: sampleRate, frameMs: PCM_FRAME_MS },
      });
      node.port.onmessage = (e: MessageEvent<unknown>): void => {
        if (e.data instanceof ArrayBuffer) onFrame(e.data);
      };
      // A worklet nobody pulls from is not guaranteed to run, so it feeds a silent sink.
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(context.destination);
      this.worklet = node;
      this.sink = sink;
      return true;
    } catch {
      this.stopStreaming();
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Disconnects the PCM capture. The microphone itself is released by `release`. */
  stopStreaming(): void {
    const node = this.worklet;
    this.worklet = null;
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    this.sink?.disconnect();
    this.sink = null;
  }

  /** Every exit releases the microphone: end, unmount, a fallback, a refused permission. */
  release(): void {
    this.stopStreaming();
    this.source = null;
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.analyser = null;
    this.samples = null;
    const context = this.context;
    this.context = null;
    context?.close().catch(() => undefined);
  }
}

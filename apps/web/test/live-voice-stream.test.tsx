import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveVoiceCall } from "@/components/participant/LiveVoiceCall";
import { useLiveVoice, type LiveVoiceCallbacks, type LiveVoiceController } from "@/hooks/useLiveVoice";
import { PCM_WORKLET_NAME, PCM_WORKLET_SOURCE } from "@/lib/voice/pcm-worklet";

/*
 * Streaming captions (FR-30a, D-77) in the browser: the server says `mode: "stream"`, the hook
 * captures PCM through an AudioWorklet and sends it as binary, and captions grow as the participant
 * talks. jsdom has no Web Audio, so the worklet node is a stub whose port a test can post frames on.
 */

let rms = 0;

class WorkletNodeStub {
  static latest: WorkletNodeStub | null = null;
  readonly port = { onmessage: null as ((e: { data: unknown }) => void) | null };
  disconnected = false;
  constructor(
    readonly context: unknown,
    readonly name: string,
    readonly options: { processorOptions?: { targetRate?: number } },
  ) {
    WorkletNodeStub.latest = this;
  }
  connect(): void {
    return undefined;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  /** One frame of PCM out of the worklet. */
  frame(bytes = 3840): void {
    this.port.onmessage?.({ data: new ArrayBuffer(bytes) });
  }
}

class AudioContextStub {
  static withWorklet = true;
  readonly destination = {};
  readonly audioWorklet = AudioContextStub.withWorklet
    ? { addModule: vi.fn(() => Promise.resolve()) }
    : undefined;
  createAnalyser() {
    return {
      fftSize: 1024,
      getByteTimeDomainData: (out: Uint8Array) => out.fill(Math.min(255, Math.round(128 + rms * 128))),
    };
  }
  createMediaStreamSource() {
    return { connect: () => undefined };
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class SocketStub {
  static instances: SocketStub[] = [];
  readyState = 1;
  binaryType = "blob";
  readonly sent: unknown[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onopen: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    SocketStub.instances.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  emit(frame: Record<string, unknown>): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }
  frames(): { type: string; [k: string]: unknown }[] {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d) as { type: string });
  }
  binary(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

function microphone(): { stopped: () => number } {
  const stop = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop }] }) },
    writable: true,
    configurable: true,
  });
  return { stopped: () => stop.mock.calls.length };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

const callbacks = (over: Partial<LiveVoiceCallbacks> = {}): LiveVoiceCallbacks => ({
  onTurn: vi.fn(),
  onHeard: vi.fn(),
  onEnded: vi.fn(),
  onError: vi.fn(),
  onUnavailable: vi.fn(),
  ...over,
});

/** The recorder stub's last instance: set only when a call fell back to recording utterances. */
const recorderSlot = (): { latest: unknown } => window.MediaRecorder as unknown as { latest: unknown };

beforeEach(() => {
  rms = 0;
  SocketStub.instances = [];
  WorkletNodeStub.latest = null;
  AudioContextStub.withWorklet = true;
  recorderSlot().latest = null;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", SocketStub);
  vi.stubGlobal("AudioContext", AudioContextStub);
  vi.stubGlobal("AudioWorkletNode", WorkletNodeStub);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function streamingCall(cbs: LiveVoiceCallbacks, ready: Record<string, unknown> = {}) {
  const hook = renderHook(() => useLiveVoice(cbs));
  act(() => {
    hook.result.current.start();
  });
  await settle();
  const socket = SocketStub.instances.at(-1)!;
  socket.emit({ type: "ready", captions: true, bargeIn: true, mode: "stream", sampleRate: 24000, ...ready });
  await settle();
  const opening = socket.frames();
  socket.clear();
  return { ...hook, socket, opening };
}

describe("useLiveVoice in stream mode", () => {
  it("captures through the PCM worklet at the server's rate and sends each frame as binary", async () => {
    microphone();
    const { result, socket } = await streamingCall(callbacks());

    const node = WorkletNodeStub.latest;
    expect(node?.name).toBe(PCM_WORKLET_NAME);
    expect(node?.options.processorOptions?.targetRate).toBe(24000);
    expect(result.current.mode).toBe("stream");

    node?.frame();
    node?.frame();
    expect(socket.binary()).toHaveLength(2);

    // Loud speech starts no recording: the provider decides where utterances end.
    rms = 0.3;
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(recorderSlot().latest).toBeNull();
    expect(socket.frames()).toEqual([]);
  });

  it("grows the caption as the participant talks and hands on only the finished one", async () => {
    microphone();
    const onHeard = vi.fn();
    const { result, socket } = await streamingCall(callbacks({ onHeard }));

    socket.emit({ type: "speech_started", barged: false });
    socket.emit({ type: "caption_partial", text: "We copy" });
    expect(result.current.partial).toBe("We copy");
    socket.emit({ type: "caption_partial", text: "We copy every figure" });
    expect(result.current.partial).toBe("We copy every figure");
    expect(onHeard).not.toHaveBeenCalled();

    socket.emit({ type: "caption_final", role: "user", text: "We copy every figure by hand." });
    expect(onHeard).toHaveBeenCalledWith("We copy every figure by hand.");
    expect(result.current.partial).toBe("");
    expect(result.current.status).toBe("thinking");
  });

  it("stops the interviewer when the provider hears the participant, without a second barge", async () => {
    microphone();
    const { result, socket } = await streamingCall(callbacks());
    socket.emit({ type: "speech_start", mime: "audio/ogg", shortened: false });
    expect(result.current.status).toBe("speaking");

    socket.emit({ type: "speech_started", barged: true });
    expect(result.current.status).toBe("listening");
    expect(socket.frames()).toEqual([]);

    // When the server was no longer synthesizing, the playback here is the only thing to stop,
    // and the server is told so it counts the interruption.
    socket.emit({ type: "speech_start", mime: "audio/ogg", shortened: false });
    socket.emit({ type: "speech_started", barged: false });
    expect(socket.frames()).toEqual([{ type: "barge" }]);
  });

  it("sends nothing while the interviewer talks when barge-in is off", async () => {
    microphone();
    const { socket } = await streamingCall(callbacks(), { bargeIn: false });
    socket.emit({ type: "speech_start", mime: "audio/ogg", shortened: false });

    WorkletNodeStub.latest?.frame();

    expect(socket.binary()).toHaveLength(0);
  });

  it("switches to recordings when the server drops to utterance mode, and says so", async () => {
    microphone();
    const { result, socket } = await streamingCall(callbacks());
    const node = WorkletNodeStub.latest;

    socket.emit({ type: "mode", mode: "utterance", reason: "stt_stream_failed" });

    expect(socket.frames()).toEqual([{ type: "capture", mode: "utterance" }]);
    expect(node?.disconnected).toBe(true);
    expect(result.current.mode).toBe("utterance");
    // And the rung below works as it always has: speech starts a recording.
    rms = 0.2;
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(recorderSlot().latest).not.toBeNull();
  });

  it("asks for utterance mode itself in a browser without AudioWorklet", async () => {
    microphone();
    AudioContextStub.withWorklet = false;
    const { result, opening } = await streamingCall(callbacks());

    expect(result.current.mode).toBe("utterance");
    expect(opening).toContainEqual({ type: "capture", mode: "utterance" });
    expect(WorkletNodeStub.latest).toBeNull();
  });

  it("captures once after a dropped socket reconnects, not once per connection", async () => {
    microphone();
    const { socket } = await streamingCall(callbacks());
    const first = WorkletNodeStub.latest!;

    // The socket drops; the call reconnects once and the server says `ready` again.
    act(() => {
      socket.onclose?.({});
    });
    await settle();
    const again = SocketStub.instances.at(-1)!;
    expect(again).not.toBe(socket);
    again.emit({ type: "ready", captions: true, bargeIn: true, mode: "stream", sampleRate: 24000 });
    await settle();
    again.clear();

    // The first connection's worklet must be gone: two would send every frame twice, and the
    // provider would hear the participant's words doubled over each other.
    expect(first.disconnected).toBe(true);
    expect(first.port.onmessage).toBeNull();
    WorkletNodeStub.latest?.frame();
    expect(again.binary()).toHaveLength(1);
  });

  it("releases the worklet and the microphone when the call ends", async () => {
    const mic = microphone();
    const { result } = await streamingCall(callbacks());
    const node = WorkletNodeStub.latest;

    act(() => {
      result.current.end();
    });

    expect(node?.disconnected).toBe(true);
    expect(mic.stopped()).toBe(1);
  });
});

describe("the partial caption on screen", () => {
  const controller = (over: Partial<LiveVoiceController>): LiveVoiceController => ({
    status: "listening",
    level: 0,
    captions: true,
    textOnly: false,
    notHeard: false,
    partial: "",
    mode: "stream",
    muted: false,
    problem: null,
    start: vi.fn(),
    end: vi.fn(),
    setMuted: vi.fn(),
    stopSpeaking: vi.fn(),
    dismissProblem: vi.fn(),
    ...over,
  });

  it("shows the growing text outside every live region, so screen readers are not flooded", () => {
    render(<LiveVoiceCall live={controller({ partial: "We copy every figure" })} onStart={vi.fn()} />);

    const text = screen.getByText("We copy every figure");
    const paragraph = text.closest("p");
    expect(paragraph).toHaveAttribute("aria-live", "off");
    expect(text.closest('[role="status"],[aria-live="polite"],[aria-live="assertive"]')).toBeNull();
  });
});

describe("the PCM worklet", () => {
  /** Runs the processor source with the three globals an AudioWorkletGlobalScope provides. */
  function processor(sampleRate: number, frameMs: number) {
    let Ctor: (new (o: unknown) => { process: (i: Float32Array[][]) => boolean; port: unknown }) | undefined;
    class Base {
      port = { posted: [] as ArrayBuffer[], postMessage: (b: ArrayBuffer) => this.port.posted.push(b) };
    }
    // The processor ships as source text for a Blob URL, so running it means evaluating that text.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", PCM_WORKLET_SOURCE)(
      Base,
      (name: string, c: typeof Ctor) => {
        expect(name).toBe(PCM_WORKLET_NAME);
        Ctor = c;
      },
      sampleRate,
    );
    const p = new Ctor!({ processorOptions: { targetRate: 24000, frameMs } }) as unknown as {
      process: (i: Float32Array[][]) => boolean;
      port: { posted: ArrayBuffer[] };
    };
    return p;
  }

  it("halves 48 kHz into 24 kHz PCM16 frames of the requested length", () => {
    const p = processor(48000, 10); // 240 samples per frame at 24 kHz
    const block = new Float32Array(128).fill(0.5);
    for (let i = 0; i < 4; i++) p.process([[block]]); // 512 in → 256 out → one full frame

    expect(p.port.posted).toHaveLength(1);
    const pcm = new Int16Array(p.port.posted[0]!);
    expect(pcm).toHaveLength(240);
    expect(pcm[0]).toBe(Math.round(0.5 * 0x7fff));
  });

  it("keeps the rate exact across blocks at 44.1 kHz, where the ratio is not whole", () => {
    const p = processor(44100, 1000); // one-second frames
    const block = new Float32Array(441).fill(-0.25);
    for (let i = 0; i < 100; i++) p.process([[block]]); // exactly one second in

    expect(p.port.posted).toHaveLength(1);
    expect(new Int16Array(p.port.posted[0]!)[10]).toBe(Math.round(-0.25 * 0x8000));
  });
});

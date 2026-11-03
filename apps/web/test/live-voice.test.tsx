import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewScreen } from "@/components/participant/InterviewScreen";
import { useLiveVoice, type LiveVoiceCallbacks } from "@/hooks/useLiveVoice";
import type { ParticipantApi } from "@/lib/api/participant";

// The interview screen carries the language switch, which refreshes the route.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

/*
 * jsdom has no socket, no Web Audio and no microphone. These three stubs give the call a browser
 * that works and, more importantly, a loudness a test can dictate: the hands-free part of FR-30a is
 * a decision about how loud the room is, so every assertion below is really about `rms`.
 */

/** The root-mean-square the analyser reports, in the 0..1 the hook's thresholds are written in. */
let rms = 0;

class AnalyserStub {
  fftSize = 1024;
  getByteTimeDomainData(out: Uint8Array): void {
    // A constant offset from the midpoint has exactly that offset as its RMS.
    out.fill(Math.min(255, Math.round(128 + rms * 128)));
  }
}

class AudioContextStub {
  closed = false;
  createAnalyser(): AnalyserStub {
    return new AnalyserStub();
  }
  createMediaStreamSource(): { connect: (target: unknown) => void } {
    return { connect: () => undefined };
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class SocketStub {
  static instances: SocketStub[] = [];
  readyState = 1; // OPEN: the hook sends nothing before the server's `ready` anyway
  binaryType = "blob";
  readonly sent: unknown[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    SocketStub.instances.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  /** A server frame arriving. */
  emit(frame: Record<string, unknown>): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }
  audio(): void {
    act(() => {
      this.onmessage?.({ data: new ArrayBuffer(16) });
    });
  }
  /** The socket going away without anyone asking it to. */
  drop(): void {
    this.readyState = 3;
    act(() => {
      this.onclose?.({});
    });
  }
  frames(): { type: string; [k: string]: unknown }[] {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d) as { type: string });
  }
  blobs(): unknown[] {
    return this.sent.filter((d) => typeof d !== "string");
  }
  clear(): void {
    this.sent.length = 0;
  }
}

interface RecorderStub {
  timeslice: number | undefined;
  state: string;
}

function latestRecorder(): RecorderStub | null {
  return (window.MediaRecorder as unknown as { latest: RecorderStub | null }).latest;
}

/** Replaces the microphone for one test and reports whether its tracks were released. */
function microphone(): { stopped: () => number; asked: () => number } {
  const stop = vi.fn();
  const getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop }] }));
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    writable: true,
    configurable: true,
  });
  return { stopped: () => stop.mock.calls.length, asked: () => getUserMedia.mock.calls.length };
}

function newestSocket(): SocketStub {
  return SocketStub.instances[SocketStub.instances.length - 1]!;
}

/** Lets the microphone promise and the socket handlers settle without advancing the clock. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function tickFor(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
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

beforeEach(() => {
  rms = 0;
  SocketStub.instances = [];
  (window.MediaRecorder as unknown as { latest: unknown }).latest = null;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", SocketStub);
  vi.stubGlobal("AudioContext", AudioContextStub);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Starts a call and answers the handshake, which is where every test below begins. */
async function callInProgress(
  cbs: LiveVoiceCallbacks,
  ready: { captions?: boolean; bargeIn?: boolean } = {},
): Promise<{
  result: { current: ReturnType<typeof useLiveVoice> };
  socket: SocketStub;
  /** What the handshake itself put on the wire, cleared so each test asserts only its own frames. */
  opening: { type: string }[];
  unmount: () => void;
}> {
  const { result, unmount } = renderHook(() => useLiveVoice(cbs));
  act(() => {
    result.current.start();
  });
  await settle();
  const socket = newestSocket();
  socket.emit({ type: "ready", captions: true, bargeIn: true, ...ready });
  const opening = socket.frames();
  socket.clear();
  return { result, socket, opening, unmount };
}

describe("useLiveVoice", () => {
  it("opens a same-origin socket and starts listening when the server is ready", async () => {
    microphone();
    const cbs = callbacks();
    const { result, socket, opening } = await callInProgress(cbs);

    expect(SocketStub.instances).toHaveLength(1);
    expect(socket.url).toBe("ws://localhost:3000/api/v1/p/session/live");
    expect(result.current.status).toBe("listening");
    expect(result.current.captions).toBe(true);
    // The question already on screen is read aloud, so entering a call is never silence. It
    // takes no turn, so the participant may start answering over it straight away.
    expect(opening).toEqual([{ type: "speak_last" }]);
  });

  it("reads the question aloud again after a reconnect, rather than leaving a gap", async () => {
    microphone();
    const { socket } = await callInProgress(callbacks());
    socket.drop();
    const reopened = newestSocket();
    reopened.emit({ type: "ready", captions: true, bargeIn: true });
    expect(reopened.frames()).toEqual([{ type: "speak_last" }]);
  });

  it("sends an utterance after a pause in speech, in chunks, and only when something was said", async () => {
    microphone();
    const { result, socket } = await callInProgress(callbacks());

    // A quiet room, for longer than the silence window: nothing was ever said, so nothing is sent.
    tickFor(3000);
    expect(latestRecorder()).toBeNull();
    expect(socket.frames()).toEqual([]);

    rms = 0.2;
    tickFor(200);
    const recorder = latestRecorder();
    expect(recorder).not.toBeNull();
    expect(recorder?.timeslice).toBe(250);
    expect(result.current.status).toBe("listening");

    // Still talking: half the silence window is not the end of an utterance.
    rms = 0;
    tickFor(400);
    expect(socket.frames()).toEqual([]);
    rms = 0.2;
    tickFor(200);
    rms = 0;
    tickFor(1000);

    expect(socket.frames()).toEqual([{ type: "utterance", durationMs: expect.any(Number) }]);
    expect(socket.blobs().length).toBeGreaterThan(0);
    expect(recorder?.state).toBe("inactive");
    expect(result.current.status).toBe("thinking");
  });

  it("interrupts the interviewer when the participant talks over it, and stops the audio", async () => {
    microphone();
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, "pause");
    const { result, socket } = await callInProgress(callbacks());

    socket.emit({ type: "turn", message: { id: "a1", role: "assistant", content: "Tell me more" } });
    socket.emit({ type: "speech_start", mime: "audio/ogg", shortened: false });
    socket.audio();
    socket.emit({ type: "speech_end", interrupted: false });
    await settle();
    expect(result.current.status).toBe("speaking");

    rms = 0.4;
    tickFor(250);
    expect(socket.frames()).toEqual([{ type: "barge" }]);
    expect(pause).toHaveBeenCalled();
    // They are already talking, so the interrupted moment is the start of their answer.
    expect(result.current.status).toBe("listening");
    expect(latestRecorder()).not.toBeNull();
  });

  it("leaves the interviewer alone when the tenant turned barge-in off", async () => {
    microphone();
    const { socket } = await callInProgress(callbacks(), { bargeIn: false });
    socket.emit({ type: "speech_start", mime: "audio/ogg", shortened: false });
    rms = 0.5;
    tickFor(500);
    expect(socket.frames()).toEqual([]);
  });

  it("still lets the participant stop the interviewer from the button", async () => {
    microphone();
    const { result, socket } = await callInProgress(callbacks(), { bargeIn: false });
    socket.emit({ type: "speech_start", mime: "audio/ogg", shortened: false });
    act(() => {
      result.current.stopSpeaking();
    });
    expect(socket.frames()).toEqual([{ type: "barge" }]);
    expect(result.current.status).toBe("listening");
  });

  it("drops to the recorded microphone when the cascade cannot hear, releasing the device", async () => {
    const mic = microphone();
    const onUnavailable = vi.fn();
    const { result, socket } = await callInProgress(callbacks({ onUnavailable }));

    socket.emit({ type: "unavailable", reason: "transcription_failed", fallback: "recorded" });
    expect(onUnavailable).toHaveBeenCalledWith("recorded", "transcription_failed");
    expect(result.current.status).toBe("unavailable");
    expect(mic.stopped()).toBe(1);
  });

  it("asks for typing, not the microphone, when there is no route that listens at all", async () => {
    const mic = microphone();
    const onUnavailable = vi.fn();
    const { result, socket } = await callInProgress(callbacks({ onUnavailable }));

    socket.emit({ type: "unavailable", reason: "no_transcription_route", fallback: "text" });
    expect(onUnavailable).toHaveBeenCalledWith("text", "no_transcription_route");
    expect(result.current.status).toBe("unavailable");
    expect(mic.stopped()).toBe(1);
  });

  it("treats a rung it does not recognize as text, the one that cannot itself be broken", async () => {
    microphone();
    const onUnavailable = vi.fn();
    const { socket } = await callInProgress(callbacks({ onUnavailable }));

    socket.emit({ type: "unavailable", reason: "something_new", fallback: "semaphore" });
    expect(onUnavailable).toHaveBeenCalledWith("text", "something_new");
  });

  it("stays in the call, without waiting for audio, when only the voice is gone", async () => {
    const mic = microphone();
    const onUnavailable = vi.fn();
    const { result, socket } = await callInProgress(callbacks({ onUnavailable }));

    socket.emit({ type: "unavailable", reason: "no_tts_route", fallback: "captions" });
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(result.current.textOnly).toBe(true);
    expect(result.current.status).toBe("listening");
    expect(mic.stopped()).toBe(0);

    // With no speech coming, a turn hands the floor straight back rather than waiting for audio.
    socket.emit({ type: "turn", message: { id: "a1", role: "assistant", content: "And then?" } });
    expect(result.current.status).toBe("listening");
  });

  it("reopens a socket that drops once, then falls back when the second one drops too", async () => {
    microphone();
    const onUnavailable = vi.fn();
    const { result, socket } = await callInProgress(callbacks({ onUnavailable }));

    socket.drop();
    expect(SocketStub.instances).toHaveLength(2);
    expect(result.current.status).toBe("connecting");
    expect(onUnavailable).not.toHaveBeenCalled();

    SocketStub.instances[1]!.drop();
    expect(SocketStub.instances).toHaveLength(2);
    expect(onUnavailable).toHaveBeenCalledWith("recorded", "connection_lost");
    expect(result.current.problem).toBe("lost");
    expect(result.current.status).toBe("unavailable");
  });

  it("says nothing was heard rather than sending an empty answer on", async () => {
    microphone();
    const { result, socket } = await callInProgress(callbacks());
    rms = 0.2;
    tickFor(200);
    rms = 0;
    tickFor(1000);
    socket.emit({ type: "not_heard" });
    expect(result.current.notHeard).toBe(true);
    expect(result.current.status).toBe("listening");
  });

  it("releases the microphone when the call ends, when the interview ends and on unmount", async () => {
    const first = microphone();
    const { result, socket } = await callInProgress(callbacks());
    act(() => {
      result.current.end();
    });
    expect(first.stopped()).toBe(1);
    expect(socket.frames()).toEqual([{ type: "bye" }]);
    expect(result.current.status).toBe("idle");

    const onEnded = vi.fn();
    const second = microphone();
    const ending = await callInProgress(callbacks({ onEnded }));
    ending.socket.emit({ type: "ended", summaryAvailable: true });
    expect(onEnded).toHaveBeenCalledWith(true);
    expect(second.stopped()).toBe(1);

    const third = microphone();
    const last = await callInProgress(callbacks());
    act(() => {
      last.unmount();
    });
    expect(third.stopped()).toBe(1);
  });

  it("explains a refused microphone without opening a socket", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () => {
          const e = new Error("NotAllowedError");
          e.name = "NotAllowedError";
          return Promise.reject(e);
        },
      },
      writable: true,
      configurable: true,
    });
    const { result } = renderHook(() => useLiveVoice(callbacks()));
    act(() => {
      result.current.start();
    });
    await settle();
    expect(result.current.problem).toBe("denied");
    expect(result.current.status).toBe("idle");
    expect(SocketStub.instances).toHaveLength(0);
  });

  it("explains a browser with no Web Audio without ever asking for the microphone", async () => {
    const mic = microphone();
    vi.stubGlobal("AudioContext", undefined);
    const { result } = renderHook(() => useLiveVoice(callbacks()));
    act(() => {
      result.current.start();
    });
    await settle();
    expect(result.current.problem).toBe("unsupported");
    expect(mic.stopped()).toBe(0);
    expect(SocketStub.instances).toHaveLength(0);
  });
});

describe("the interview screen in a live call", () => {
  const session = (over: Record<string, unknown> = {}): unknown => ({
    id: "s1",
    status: "active",
    consented: true,
    progress: { areas: [] },
    messages: [
      { id: "a1", seq: 1, role: "assistant", modality: "text", content: "Hello there", createdAt: "" },
    ],
    attachments: [],
    modePreference: "chat",
    capabilities: {
      recordedVoice: true,
      liveVoice: true,
      captions: true,
      fileUpload: false,
      maxSizeMb: 20,
      allowedTypes: ["application/pdf"],
    },
    ...over,
  });
  const api = {
    listAttachments: () => Promise.resolve([]),
    setMode: () => Promise.resolve(),
  } as unknown as ParticipantApi;

  async function enterVoice(initial: unknown = session()): Promise<SocketStub> {
    render(<InterviewScreen initial={initial as never} api={api} />);
    // Talk opens the call itself; there is no second button to press.
    fireEvent.click(screen.getByRole("button", { name: "Talk" }));
    await settle();
    return newestSocket();
  }

  it("shows each exchange once, although the turn and the caption both carry the interviewer", async () => {
    microphone();
    const socket = await enterVoice();
    socket.emit({ type: "ready", captions: true, bargeIn: true });
    expect(screen.getByText("Listening")).toBeInTheDocument();

    socket.emit({ type: "caption", role: "user", text: "I run the support desk." });
    socket.emit({
      type: "turn",
      message: { id: "a2", seq: 2, role: "assistant", content: "How big is the team?", createdAt: "" },
      ended: false,
      progress: { areas: [] },
    });
    socket.emit({ type: "caption", role: "assistant", text: "How big is the team?" });

    // Counted inside the conversation: the visually hidden announcer repeats the interviewer's
    // finished turn once on purpose (asserted in interview-a11y.test.tsx).
    const conversation = within(screen.getByRole("list", { name: "Conversation" }));
    expect(conversation.getAllByText("How big is the team?")).toHaveLength(1);
    expect(conversation.getAllByText("I run the support desk.")).toHaveLength(1);
  });

  it("keeps typing available during the call and hangs up when the participant types", async () => {
    microphone();
    const socket = await enterVoice();
    socket.emit({ type: "ready", captions: true, bargeIn: true });
    expect(screen.getByRole("button", { name: "End the call" })).toBeInTheDocument();
    // Only one microphone at a time: the record button steps aside while the call is up.
    expect(screen.queryByRole("button", { name: "Dictate your answer" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "Four of us" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(socket.frames()).toEqual([{ type: "speak_last" }, { type: "bye" }]);
    expect(screen.queryByRole("button", { name: "End the call" })).not.toBeInTheDocument();
  });

  it("offers the recorded microphone again when transcription merely failed", async () => {
    microphone();
    const socket = await enterVoice();
    socket.emit({ type: "ready", captions: true, bargeIn: true });
    socket.emit({ type: "unavailable", reason: "transcription_failed", fallback: "recorded" });

    expect(screen.getByText(/A live call is not possible right now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dictate your answer" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your answer")).toBeInTheDocument();
  });

  it("lets the participant call again after a passing failure, with the microphone asked for afresh", async () => {
    // The owner's report: after one failed answer the voice never worked again in that visit.
    const mic = microphone();
    const socket = await enterVoice();
    socket.emit({ type: "ready", captions: true, bargeIn: true });
    socket.emit({ type: "unavailable", reason: "transcription_failed", fallback: "recorded" });
    await settle();
    // The failed call let go of the device.
    expect(mic.stopped()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Talk" }));
    await settle();
    expect(SocketStub.instances).toHaveLength(2);
    expect(mic.asked()).toBe(2);
    newestSocket().emit({ type: "ready", captions: true, bargeIn: true });
    await settle();
    expect(screen.getByRole("button", { name: "End the call" })).toBeInTheDocument();
    expect(screen.queryByText(/A live call is not possible right now/)).not.toBeInTheDocument();
  });

  it("does not offer the call again when this server cannot hear a call at all", async () => {
    microphone();
    const socket = await enterVoice();
    socket.emit({ type: "ready", captions: true, bargeIn: true });
    // The on-server Whisper reads WAV and a call sends WebM: every call would fail the same way.
    socket.emit({ type: "unavailable", reason: "transcription_needs_wav", fallback: "recorded" });
    await settle();
    expect(screen.queryByRole("button", { name: "Talk" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dictate your answer" })).toBeInTheDocument();
  });

  it("withdraws every microphone when there is no route that listens, and moves to typing", async () => {
    microphone();
    const socket = await enterVoice();
    socket.emit({ type: "ready", captions: true, bargeIn: true });
    socket.emit({ type: "unavailable", reason: "no_transcription_route", fallback: "text" });
    await settle();

    expect(
      screen.getByText("This interview cannot take spoken answers. Please type your answer instead."),
    ).toBeInTheDocument();
    // Recorded voice transcribes through the same missing route, so pointing at it would be the
    // one suggestion guaranteed to fail.
    expect(screen.queryByRole("button", { name: "Dictate your answer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End the call" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start a voice call" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Talk" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Your answer")).toBeInTheDocument();
  });

  it("never opens the microphone on load, even when voice is the stored preference", async () => {
    const mic = microphone();
    render(<InterviewScreen initial={session({ modePreference: "voice" }) as never} api={api} />);
    await settle();
    expect(mic.stopped()).toBe(0);
    expect(SocketStub.instances).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Talk" }));
    await settle();
    expect(SocketStub.instances).toHaveLength(1);
    newestSocket().emit({ type: "ready", captions: false, bargeIn: true });
    // Without captions nothing the participant says reaches this client, and they are told so.
    expect(screen.getByText(/What you say is not shown here/)).toBeInTheDocument();
  });

  it("keeps Talk out of reach when the tenant has both kinds of voice off", () => {
    render(
      <InterviewScreen
        initial={
          session({
            modePreference: "voice",
            capabilities: {
              recordedVoice: false,
              liveVoice: false,
              captions: false,
              fileUpload: false,
              maxSizeMb: 20,
              allowedTypes: [],
            },
          }) as never
        }
        api={api}
      />,
    );
    expect(screen.queryByRole("button", { name: "Talk" })).not.toBeInTheDocument();
  });
});

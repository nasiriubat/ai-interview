import type { Widget } from "@aidp/shared";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewScreen } from "@/components/participant/InterviewScreen";
import { formatElapsed, LiveVoiceScreen } from "@/components/participant/LiveVoiceScreen";
import { useLiveVoice, type LiveVoiceController } from "@/hooks/useLiveVoice";
import { setClientLocale } from "@/i18n";
import type { ParticipantApi } from "@/lib/api/participant";
import type { Message } from "@/lib/api/schemas";

/*
 * The call as a screen of its own on phones (D-238): captions of both sides, large end and mute
 * controls, one status region, focus that lands on the right control and goes back to the mode
 * switch, and nothing that moves under reduced motion. The component is tested against a fake
 * controller; the integration at the end runs the real hook against a stub socket.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

const controller = (over: Partial<LiveVoiceController> = {}): LiveVoiceController => ({
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

const message = (over: Partial<Message> & Pick<Message, "id" | "role" | "content">): Message =>
  ({ seq: 0, modality: "text", createdAt: "", ...over });

const props = (over: Partial<React.ComponentProps<typeof LiveVoiceScreen>> = {}) => ({
  live: controller(),
  open: true,
  title: "Ward round",
  messages: [
    message({ id: "a1", role: "assistant", content: "How big is the team?" }),
    message({ id: "u1", role: "user", content: "About twelve people." }),
    message({ id: "a2", role: "assistant", content: "What do they use to track tickets?" }),
  ],
  widget: undefined as Widget | undefined,
  announcement: "",
  onAnswer: vi.fn(),
  onTypeInstead: vi.fn(),
  returnFocus: vi.fn(),
  ...over,
});

beforeEach(() => {
  setClientLocale("en");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("elapsed time", () => {
  it("is minutes and seconds, never negative", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_600_000)).toBe("60:00");
    expect(formatElapsed(-5)).toBe("0:00");
  });

  it("counts while the call is open", () => {
    vi.useFakeTimers();
    render(<LiveVoiceScreen {...props()} />);
    expect(screen.getByRole("timer", { name: "Call time" })).toHaveTextContent("0:00");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByRole("timer", { name: "Call time" })).toHaveTextContent("0:03");
  });
});

describe("LiveVoiceScreen", () => {
  it("is a modal dialog named for the call, with the interview's title", () => {
    render(<LiveVoiceScreen {...props()} />);
    const dialog = screen.getByRole("dialog", { name: "Voice call" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Ward round")).toBeInTheDocument();
  });

  it("renders nothing when the call is not up", () => {
    render(<LiveVoiceScreen {...props({ open: false })} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("puts focus on End the call, the one control that is always right", async () => {
    render(<LiveVoiceScreen {...props()} />);
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: "End the call" })).toHaveFocus();
    });
  });

  it("shows the interviewer's current sentence large and what the participant said under it", () => {
    render(<LiveVoiceScreen {...props()} />);
    expect(screen.getByText("What do they use to track tickets?")).toBeInTheDocument();
    // The participant's earlier answer belongs to an earlier exchange: it is not shown as a reply
    // to a question it did not answer.
    expect(screen.queryByText("About twelve people.")).not.toBeInTheDocument();
  });

  it("shows what the participant has said since, and the growing partial in italics", () => {
    const messages = [
      message({ id: "a1", role: "assistant", content: "How big is the team?" }),
      message({ id: "u1", role: "user", content: "About twelve people." }),
    ];
    const { rerender } = render(<LiveVoiceScreen {...props({ messages })} />);
    expect(screen.getByText("About twelve people.")).toBeInTheDocument();
    rerender(
      <LiveVoiceScreen {...props({ messages, live: controller({ partial: "and three on nights" }) })} />,
    );
    const partial = screen.getByText("and three on nights");
    expect(partial.tagName).toBe("SPAN");
    expect(partial.closest("p")).toHaveAttribute("aria-live", "off");
  });

  it("names the phase in a word in the one status region, and says so when muted", () => {
    const { rerender } = render(<LiveVoiceScreen {...props({ live: controller({ status: "thinking" }) })} />);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("The interviewer is thinking");
    rerender(<LiveVoiceScreen {...props({ live: controller({ status: "speaking" }) })} />);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent("The interviewer is speaking");
    rerender(<LiveVoiceScreen {...props({ live: controller({ muted: true }) })} />);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      "Your microphone is off. The interviewer cannot hear you.",
    );
  });

  it("announces the interviewer's finished sentence once, in its own visually hidden status", () => {
    render(<LiveVoiceScreen {...props({ announcement: "What do they use to track tickets?" })} />);
    const announcers = screen
      .getAllByRole("status")
      .filter((el) => el.className.includes("sr-only") && el.textContent !== "");
    expect(announcers).toHaveLength(1);
    expect(announcers[0]).toHaveTextContent("What do they use to track tickets?");
    // The visible caption is not a live region, or every sentence would be read twice.
    expect(
      screen.getByText("What do they use to track tickets?", { selector: "p[aria-live]" }),
    ).toHaveAttribute("aria-live", "off");
  });

  it("toggles the microphone with a pressed button", async () => {
    const live = controller();
    const user = userEvent.setup();
    const { rerender } = render(<LiveVoiceScreen {...props({ live })} />);
    const mute = screen.getByRole("button", { name: "Mute microphone" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    await user.click(mute);
    expect(live.setMuted).toHaveBeenCalledWith(true);
    rerender(<LiveVoiceScreen {...props({ live: controller({ muted: true, setMuted: live.setMuted }) })} />);
    const unmute = screen.getByRole("button", { name: "Unmute microphone" });
    expect(unmute).toHaveAttribute("aria-pressed", "true");
    await user.click(unmute);
    expect(live.setMuted).toHaveBeenLastCalledWith(false);
  });

  it("offers Interrupt only while the interviewer is speaking, and always the way out", async () => {
    const live = controller({ status: "speaking" });
    const user = userEvent.setup();
    const { rerender } = render(<LiveVoiceScreen {...props({ live })} />);
    await user.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(live.stopSpeaking).toHaveBeenCalled();
    const next = controller({ status: "listening" });
    rerender(<LiveVoiceScreen {...props({ live: next })} />);
    expect(screen.queryByRole("button", { name: "Interrupt" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "End the call" }));
    expect(next.end).toHaveBeenCalled();
  });

  it("ends the call on End, and on Escape, and hands focus back through returnFocus", async () => {
    const live = controller();
    const returnFocus = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<LiveVoiceScreen {...props({ live, returnFocus })} />);
    await user.click(screen.getByRole("button", { name: "End the call" }));
    expect(live.end).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(live.end).toHaveBeenCalledTimes(2);
    rerender(<LiveVoiceScreen {...props({ live, returnFocus, open: false })} />);
    await vi.waitFor(() => {
      expect(returnFocus).toHaveBeenCalled();
    });
  });

  it("lets a tap answer a single choice, and a yes or no", async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    const single: Widget = {
      type: "single_choice",
      options: [
        { key: "jira", label: "Jira" },
        { key: "mail", label: "Email" },
      ],
    };
    const { rerender } = render(<LiveVoiceScreen {...props({ widget: single, onAnswer })} />);
    await user.click(screen.getByRole("radio", { name: "Email" }));
    expect(onAnswer).toHaveBeenCalledWith({ type: "single_choice", key: "mail" });

    rerender(<LiveVoiceScreen {...props({ widget: { type: "yes_no" }, onAnswer })} />);
    await user.click(screen.getByRole("radio", { name: "No" }));
    expect(onAnswer).toHaveBeenLastCalledWith({ type: "yes_no", value: false });
  });

  it("does not offer taps for answers that need more than a tap", () => {
    const multi: Widget = {
      type: "multi_choice",
      options: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
    };
    render(<LiveVoiceScreen {...props({ widget: multi })} />);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("leaves the call for typing on request", async () => {
    const onTypeInstead = vi.fn();
    const user = userEvent.setup();
    render(<LiveVoiceScreen {...props({ onTypeInstead })} />);
    await user.click(screen.getByRole("button", { name: "Type instead" }));
    expect(onTypeInstead).toHaveBeenCalled();
  });

  it("says what is not shown when the server sends no captions, and what could not be heard", () => {
    render(
      <LiveVoiceScreen
        {...props({ live: controller({ captions: false, notHeard: true, textOnly: true }) })}
      />,
    );
    expect(screen.getByText(/What you say is not shown here/)).toBeInTheDocument();
    expect(screen.getByText(/did not catch that/)).toBeInTheDocument();
    expect(screen.getByText(/voice is not available/i)).toBeInTheDocument();
  });

  it("shows the conversation so far on request, with who said what for a screen reader", async () => {
    const user = userEvent.setup();
    render(<LiveVoiceScreen {...props()} />);
    const toggle = screen.getByRole("button", { name: "Show conversation" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    const section = screen.getByRole("region", { name: "Conversation so far" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(section).toHaveTextContent("You: About twelve people.");
    expect(screen.getByRole("button", { name: "Hide conversation" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("is in Finnish when the page is", () => {
    setClientLocale("fi");
    render(<LiveVoiceScreen {...props()} />);
    expect(screen.getByRole("dialog", { name: "Puhelu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mykistä mikrofoni" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lopeta puhelu" })).toBeInTheDocument();
  });

  it("starts no animation of its own under reduced motion: spinners are motion-safe only", () => {
    render(<LiveVoiceScreen {...props({ live: controller({ status: "connecting" }) })} />);
    const icon = screen.getAllByRole("status")[0]!.querySelector("svg")!;
    expect(icon.getAttribute("class")).toContain("motion-safe:animate-spin");
    expect(icon.getAttribute("class")).not.toMatch(/(^|\s)animate-spin/);
  });
});

/* ---- the real hook, for what the controller promises: mute is the microphone, not a flag ---- */

class AudioContextStub {
  createAnalyser(): { fftSize: number; getByteTimeDomainData: (out: Uint8Array) => void } {
    return { fftSize: 1024, getByteTimeDomainData: (out) => out.fill(128) };
  }
  createMediaStreamSource(): { connect: (target: unknown) => void } {
    return { connect: () => undefined };
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
  emit(frame: Record<string, unknown>): void {
    act(() => {
      this.onmessage?.({ data: JSON.stringify(frame) });
    });
  }
}

function microphone(): { tracks: { enabled: boolean; stop: () => void }[] } {
  const tracks = [{ enabled: true, stop: vi.fn() }];
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: () => Promise.resolve({ getTracks: () => tracks }) },
    writable: true,
    configurable: true,
  });
  return { tracks };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("mute on a real call", () => {
  beforeEach(() => {
    SocketStub.instances = [];
    vi.stubGlobal("WebSocket", SocketStub);
    vi.stubGlobal("AudioContext", AudioContextStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables the microphone track, keeps the call, and unmutes without a new permission prompt", async () => {
    const mic = microphone();
    const { result } = renderHook(() =>
      useLiveVoice({
        onTurn: vi.fn(),
        onHeard: vi.fn(),
        onEnded: vi.fn(),
        onError: vi.fn(),
        onUnavailable: vi.fn(),
      }),
    );
    act(() => {
      result.current.start();
    });
    await settle();
    SocketStub.instances.at(-1)!.emit({ type: "ready", captions: true, bargeIn: true });

    act(() => {
      result.current.setMuted(true);
    });
    expect(result.current.muted).toBe(true);
    expect(result.current.status).toBe("listening");
    expect(mic.tracks[0]?.enabled).toBe(false);
    expect(mic.tracks[0]?.stop).not.toHaveBeenCalled();

    act(() => {
      result.current.setMuted(false);
    });
    expect(mic.tracks[0]?.enabled).toBe(true);

    act(() => {
      result.current.setMuted(true);
      result.current.end();
    });
    expect(result.current.muted).toBe(false);
    expect(mic.tracks[0]?.stop).toHaveBeenCalled();
  });
});

/* ---- the interview screen on a phone ---- */

describe("the interview screen on a phone", () => {
  const session = {
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
      allowedTypes: [],
    },
  };
  const api = {
    listAttachments: () => Promise.resolve([]),
    setMode: () => Promise.resolve(),
  } as unknown as ParticipantApi;

  const matchMedia = (phone: boolean) =>
    vi.fn().mockImplementation((query: string) => ({
      matches: phone && query.includes("max-width: 767px"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));

  beforeEach(() => {
    SocketStub.instances = [];
    vi.stubGlobal("WebSocket", SocketStub);
    vi.stubGlobal("AudioContext", AudioContextStub);
    microphone();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the call as a screen, hides the panel under it, and returns focus to the mode switch", async () => {
    vi.stubGlobal("matchMedia", matchMedia(true));
    window.matchMedia = matchMedia(true) as never;
    render(<InterviewScreen initial={session as never} api={api} />);
    fireEvent.click(screen.getByRole("radio", { name: "Voice" }));
    await settle();
    SocketStub.instances.at(-1)!.emit({ type: "ready", captions: true, bargeIn: true });

    const dialog = await screen.findByRole("dialog", { name: "Voice call" });
    expect(within(dialog).getByText("Hello there")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("status")[0]).toHaveTextContent("Listening");
    // One End control: the panel above the composer steps aside while the screen is up.
    expect(screen.getAllByRole("button", { name: "End the call", hidden: true })).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "End the call" }));
    await settle();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.getByRole("radio", { name: "Voice" })).toHaveFocus();
    });
  });

  it("keeps the panel and no dialog on a wider screen", async () => {
    vi.stubGlobal("matchMedia", matchMedia(false));
    window.matchMedia = matchMedia(false) as never;
    render(<InterviewScreen initial={session as never} api={api} />);
    fireEvent.click(screen.getByRole("radio", { name: "Voice" }));
    await settle();
    SocketStub.instances.at(-1)!.emit({ type: "ready", captions: true, bargeIn: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End the call" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeInTheDocument();
  });
});

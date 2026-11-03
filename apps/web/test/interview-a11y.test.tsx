import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ParticipantError from "@/app/p/error";
import { Composer } from "@/components/participant/Composer";
import { InterviewScreen } from "@/components/participant/InterviewScreen";
import { MessageList } from "@/components/participant/MessageList";
import { StatusScreen } from "@/components/participant/StatusScreen";
import { useInterview } from "@/hooks/useInterview";
import type { ParticipantApi } from "@/lib/api/participant";
import type { Message, ParticipantSession } from "@/lib/api/schemas";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

const enc = new TextEncoder();

/** A turn stream whose chunks the test releases one at a time, to look between them. */
function controlledStream(): {
  response: Response;
  push: (chunk: string) => void;
  end: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    push: (chunk) => {
      controller.enqueue(enc.encode(chunk));
    },
    end: () => {
      controller.close();
    },
  };
}

function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const session: ParticipantSession = {
  id: "s1",
  status: "active",
  consented: true,
  progress: { areas: [{ key: "role", name: "Role", status: "untouched" }] },
  messages: [],
  capabilities: {
    recordedVoice: false,
    liveVoice: false,
    captions: true,
    fileUpload: false,
    maxSizeMb: 20,
    allowedTypes: [],
  },
  attachments: [],
};

function apiWith(sendTurn: ParticipantApi["sendTurn"]): ParticipantApi {
  const noop = (): Promise<void> => Promise.resolve();
  const unused = (): Promise<never> => Promise.reject(new Error("unused"));
  return {
    sendTurn,
    sendVoice: unused,
    transcribe: unused,
    uploadAttachment: unused,
    listAttachments: () => Promise.resolve([]),
    attachmentBytes: unused,
    deleteAttachment: noop,
    getLink: unused,
    requestCode: noop,
    confirmCode: unused,
    open: unused,
    getInvite: unused,
    openInvite: unused,
    getSession: () => Promise.resolve(session),
    consent: noop,
    setPath: noop,
    setMode: noop,
    pause: noop,
    sendControl: unused,
    deleteData: () => Promise.resolve({ ok: true, emailSent: false }),
    getSummary: () => Promise.resolve({ summary: "", facts: [], status: "ready" as const }),
    putSummary: noop,
  };
}

const turnEvent = (content: string, extra = ""): string =>
  `event: turn\ndata: {"message":{"id":"a-${content.length}","seq":1,"role":"assistant","content":${JSON.stringify(content)}${extra},"createdAt":""},"ended":false,"progress":{"areas":[]}}\n\n`;

function setPointer(coarse: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: query.includes("pointer: coarse") ? coarse : false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  setPointer(false);
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has it
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conversation announcements", () => {
  const assistant = (content: string): Message => ({
    id: "m1",
    seq: 1,
    role: "assistant",
    modality: "text",
    content,
    createdAt: "",
  });

  it("is a plain list, not a live log, and the streaming bubble is not live", () => {
    render(
      <MessageList
        messages={[assistant("Hello")]}
        streaming="Half a sen"
        pending={false}
        announcement={null}
      />,
    );
    const list = screen.getByRole("list", { name: "Conversation" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    const streamingBubble = screen.getByText(/Half a sen/);
    expect(streamingBubble.closest("[aria-live]")).toHaveAttribute("aria-live", "off");
    // Nothing is announced while the text streams.
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("announces a completed turn once, with what kind of question it is", () => {
    const { rerender } = render(
      <MessageList messages={[]} streaming={null} pending={false} announcement={null} />,
    );
    rerender(
      <MessageList
        messages={[assistant("Which tools do you use?")]}
        streaming={null}
        pending={false}
        announcement={{
          n: 1,
          text: "Which tools do you use?",
          widget: {
            type: "multi_choice",
            max: 2,
            options: [
              { key: "a", label: "A" },
              { key: "b", label: "B" },
              { key: "c", label: "C" },
            ],
          },
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Which tools do you use? Question with 3 options, choose up to 2.",
    );
  });

  it("hands the hook one announcement per turn, never per streamed token", async () => {
    const stream = controlledStream();
    const sendTurn = vi.fn(() => Promise.resolve(stream.response));
    const { result } = renderHook(() => useInterview(apiWith(sendTurn), session));
    await waitFor(() => {
      expect(sendTurn).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      stream.push('event: text\ndata: {"delta":"Hel"}\n\n');
      stream.push('event: text\ndata: {"delta":"lo there"}\n\n');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.state.streaming).toBe("Hello there");
    });
    expect(result.current.state.lastAnnouncement).toBeNull();

    await act(async () => {
      stream.push(turnEvent("Hello there"));
      stream.end();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.state.pending).toBe(false);
    });
    expect(result.current.state.lastAnnouncement).toMatchObject({ n: 1, text: "Hello there" });
  });

  it("does not announce what the participant typed", async () => {
    const sendTurn = vi
      .fn<ParticipantApi["sendTurn"]>()
      .mockResolvedValueOnce(sse([turnEvent("First question")]))
      .mockResolvedValueOnce(sse([turnEvent("Second question, a bit longer")]));
    render(<InterviewScreen initial={session} api={apiWith(sendTurn)} />);
    await waitFor(() => {
      expect(screen.getAllByRole("status").some((s) => s.textContent === "First question")).toBe(true);
    });
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "My private answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(
        screen.getAllByRole("status").some((s) => s.textContent === "Second question, a bit longer"),
      ).toBe(true);
    });
    for (const status of screen.getAllByRole("status")) {
      expect(status.textContent).not.toContain("My private answer");
    }
  });
});

describe("Composer keyboard rules", () => {
  it("sends on Enter and breaks the line on Shift+Enter with a mouse and keyboard", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer disabled={false} onSend={onSend} />);
    const box = screen.getByLabelText("Your answer");
    expect(box).toHaveAttribute("enterkeyhint", "send");
    await user.type(box, "Hello");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("Hello\n");
    await user.keyboard("more{Enter}");
    expect(onSend).toHaveBeenCalledWith("Hello\nmore", "text");
  });

  it("makes Enter a line break on a touch device, where only the Send button sends", async () => {
    setPointer(true);
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer disabled={false} onSend={onSend} />);
    const box = screen.getByLabelText("Your answer");
    expect(box).toHaveAttribute("enterkeyhint", "enter");
    await user.type(box, "One{Enter}Two");
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue("One\nTwo");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("One\nTwo", "text");
    // No keyboard tip on a phone.
    expect(screen.queryByText(/Shift\+Enter/)).not.toBeInTheDocument();
  });

  it("shows the keyboard tip on first focus, ties it to the field, and remembers dismissal", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Composer disabled={false} onSend={vi.fn()} />);
    const box = screen.getByLabelText("Your answer");
    expect(screen.queryByText(/Shift\+Enter/)).not.toBeInTheDocument();
    await user.click(box);
    const tip = screen.getByText("Enter sends, Shift+Enter starts a new line.");
    expect(box.getAttribute("aria-describedby")).toBe(tip.closest("p")?.id);
    await user.click(screen.getByRole("button", { name: "Hide this tip" }));
    expect(screen.queryByText(/Shift\+Enter/)).not.toBeInTheDocument();
    unmount();

    render(<Composer disabled={false} onSend={vi.fn()} />);
    await user.click(screen.getByLabelText("Your answer"));
    expect(screen.queryByText(/Shift\+Enter/)).not.toBeInTheDocument();
  });

  it("gives the text back when the send failed, and does not overwrite what was typed since", async () => {
    let finish!: (delivered: boolean) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<Composer disabled={false} onSend={onSend} />);
    const box = screen.getByLabelText("Your answer");
    await user.type(box, "Important answer");
    await user.keyboard("{Enter}");
    expect(box).toHaveValue("");
    await act(async () => {
      finish(false);
      await Promise.resolve();
    });
    expect(box).toHaveValue("Important answer");

    await user.keyboard("{Enter}");
    expect(box).toHaveValue("");
    await user.type(box, "Next thought");
    await act(async () => {
      finish(false);
      await Promise.resolve();
    });
    expect(box).toHaveValue("Next thought");
  });
});

describe("offline", () => {
  function setOnLine(value: boolean): void {
    Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
  }
  afterEach(() => {
    setOnLine(true);
  });

  it("says so, keeps Retry off until the connection is back, then retries once by itself", async () => {
    const sendTurn = vi
      .fn<ParticipantApi["sendTurn"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(sse([turnEvent("Welcome back")]));
    setOnLine(false);
    render(<InterviewScreen initial={session} api={apiWith(sendTurn)} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You seem to be offline");
    expect(alert).toHaveTextContent("Your last answer was not sent. It is kept here");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeDisabled();
    expect(screen.getByText(/You are offline\. Your answer is kept/)).toBeInTheDocument();
    expect(sendTurn).toHaveBeenCalledTimes(1);

    setOnLine(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => {
      expect(sendTurn).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/You are offline/)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByRole("status").some((s) => s.textContent === "Welcome back")).toBe(true);
    });
    // One automatic retry, not a loop.
    expect(sendTurn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on its own when the browser was online and the server simply failed", async () => {
    const sendTurn = vi.fn<ParticipantApi["sendTurn"]>().mockRejectedValue(new TypeError("Failed to fetch"));
    setOnLine(true);
    render(<InterviewScreen initial={session} api={apiWith(sendTurn)} />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await Promise.resolve();
    expect(sendTurn).toHaveBeenCalledTimes(1);
  });
});

describe("focus moves to the new heading", () => {
  it("StatusScreen focuses its h1 on mount", () => {
    render(<StatusScreen title="This link has expired" body="Ask for a new one." />);
    expect(screen.getByRole("heading", { level: 1, name: "This link has expired" })).toHaveFocus();
  });

  it("the arrival flow moves focus to the next step's heading, and not on the first screen", async () => {
    const { ArrivalFlow } = await import("@/components/participant/ArrivalFlow");
    const api = {
      ...apiWith(vi.fn()),
      open: vi.fn(() => Promise.resolve({ sessionId: "s1", resume: false })),
    };
    const user = userEvent.setup();
    render(
      <ArrivalFlow
        linkToken="tok"
        api={api}
        campaign={{
          name: "Acme",
          productName: "",
          welcome: "To learn.",
          expectedMinutes: 10,
          participationMode: "anonymous",
          verification: "open",
          consentText: "Consent text.",
          participantFields: [],
          pathSelection: "none",
        }}
      />,
    );
    const first = screen.getByRole("heading", { level: 1 });
    expect(first).not.toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const next = await screen.findByRole("heading", { level: 1, name: "Before we start" });
    expect(next).toHaveFocus();
  });
});

describe("participant error page", () => {
  it("says it is our side, that nothing was lost, and gives a reference for support", () => {
    const reset = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ParticipantError error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={reset} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something went wrong on our side");
    expect(screen.getByText(/Nothing you said is lost/)).toBeInTheDocument();
    expect(screen.getByText("Reference: abc123")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewScreen } from "@/components/participant/InterviewScreen";
import { MessageList } from "@/components/participant/MessageList";
import { en } from "@/i18n/en";
import { fi } from "@/i18n/fi";
import type { ParticipantApi } from "@/lib/api/participant";
import type { ParticipantSession, ProgressArea } from "@/lib/api/schemas";
import { toTurnStreamEvent } from "@/lib/api/sse";

/*
 * Control operations (D-170): skip, come back and "I'm done" are state operations sent as a
 * `control` on the turn request. They never become something the participant said.
 */

const toasts = vi.hoisted(() => {
  const calls: { text: string; options: { action?: { label: string; onClick: () => void } } }[] = [];
  const toast = Object.assign(
    (text: string, options: (typeof calls)[number]["options"] = {}): number => {
      calls.push({ text, options });
      return calls.length;
    },
    { success: vi.fn(), error: vi.fn() },
  );
  return { calls, toast };
});

vi.mock("@/components/ui/sonner", () => ({ toast: toasts.toast, Toaster: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

const enc = new TextEncoder();
function sse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const areas = (statuses: Partial<Record<string, ProgressArea["status"]>>): ProgressArea[] => [
  { key: "role", name: "Role", status: statuses.role ?? "covered" },
  { key: "tools", name: "Tools and systems", status: statuses.tools ?? "partial" },
];

const controlEvent = (kind: string, areaKey: string | undefined, status: ProgressArea["status"]): string =>
  `event: control\ndata: ${JSON.stringify({
    kind,
    ...(areaKey ? { areaKey } : {}),
    at: "2026-10-14T10:00:00.000Z",
    progress: { areas: areas({ tools: status }) },
  })}\n\n`;

const turnEvent = (id: string, content: string, status: ProgressArea["status"] = "skipped"): string =>
  `event: turn\ndata: ${JSON.stringify({
    message: { id, seq: 3, role: "assistant", content, createdAt: "" },
    ended: false,
    progress: { areas: areas({ tools: status }) },
  })}\n\n`;

const session = (over: Partial<ParticipantSession> = {}): ParticipantSession => ({
  id: "s1",
  status: "active",
  consented: true,
  progress: { areas: areas({}) },
  messages: [
    {
      id: "m1",
      seq: 1,
      role: "assistant",
      modality: "text",
      content: "What tools do you use?",
      createdAt: "",
    },
  ] as ParticipantSession["messages"],
  capabilities: {
    recordedVoice: false,
    liveVoice: false,
    captions: true,
    fileUpload: false,
    maxSizeMb: 20,
    allowedTypes: [],
  },
  attachments: [],
  ...over,
});

function apiWith(over: Partial<ParticipantApi> = {}): ParticipantApi {
  const noop = (): Promise<void> => Promise.resolve();
  const unused = (): Promise<never> => Promise.reject(new Error("unused"));
  return {
    sendTurn: vi.fn(unused),
    sendControl: vi.fn(unused),
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
    getSession: () => Promise.resolve(session()),
    consent: noop,
    setPath: noop,
    setMode: noop,
    pause: noop,
    deleteData: () => Promise.resolve({ ok: true, emailSent: false }),
    getSummary: () => Promise.resolve({ summary: "", facts: [] }),
    putSummary: noop,
    ...over,
  };
}

beforeEach(() => {
  toasts.calls.length = 0;
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("skip and come back", () => {
  it("skipping sends a control, shows a chip rather than a participant bubble, and offers Undo", async () => {
    const sendControl = vi.fn(() =>
      Promise.resolve(
        sse([controlEvent("skip_area", "tools", "skipped"), turnEvent("a2", "Understood. Let's move on.")]),
      ),
    );
    const sendTurn = vi.fn(() => Promise.reject(new Error("a skip must not be sent as a turn")));
    const user = userEvent.setup();
    render(<InterviewScreen initial={session()} api={apiWith({ sendControl, sendTurn })} />);

    await user.click(screen.getByRole("button", { name: /^Tools and systems/ }));
    await user.click(screen.getByRole("button", { name: "Skip this for now" }));

    await waitFor(() => {
      expect(sendControl).toHaveBeenCalledTimes(1);
    });
    expect(sendControl).toHaveBeenCalledWith({ type: "skip_area", areaKey: "tools" }, expect.anything());
    // Never as a message the participant said.
    expect(sendTurn).not.toHaveBeenCalled();
    const list = await screen.findByRole("list", { name: "Conversation" });
    expect(await within(list).findByText("You skipped Tools and systems")).toBeInTheDocument();
    expect(within(list).getByText("Understood. Let's move on.")).toBeInTheDocument();
    expect(within(list).queryByText(/Let's skip/)).not.toBeInTheDocument();
    // The chip is not a participant message: no "You:" bubble exists.
    expect(within(list).queryByText(/^You:/)).not.toBeInTheDocument();

    expect(toasts.calls.map((c) => c.text)).toEqual(["Skipped Tools and systems."]);
  });

  it("Undo sends return_area, again as a control", async () => {
    const sendControl = vi
      .fn()
      .mockResolvedValueOnce(
        sse([controlEvent("skip_area", "tools", "skipped"), turnEvent("a2", "Moving on.")]),
      )
      .mockResolvedValueOnce(
        sse([controlEvent("return_area", "tools", "partial"), turnEvent("a3", "Back to tools.", "partial")]),
      );
    const user = userEvent.setup();
    render(<InterviewScreen initial={session()} api={apiWith({ sendControl })} />);
    await user.click(screen.getByRole("button", { name: /^Tools and systems/ }));
    await user.click(screen.getByRole("button", { name: "Skip this for now" }));
    await waitFor(() => {
      expect(toasts.calls).toHaveLength(1);
    });

    act(() => {
      toasts.calls[0]?.options.action?.onClick();
    });

    await waitFor(() => {
      expect(sendControl).toHaveBeenCalledTimes(2);
    });
    expect(sendControl).toHaveBeenLastCalledWith(
      { type: "return_area", areaKey: "tools" },
      expect.anything(),
    );
    expect(await screen.findByText("Back to Tools and systems")).toBeInTheDocument();
  });

  it("coming back from the progress chip is a control too", async () => {
    const sendControl = vi.fn(() =>
      Promise.resolve(
        sse([controlEvent("return_area", "tools", "partial"), turnEvent("a2", "Back.", "partial")]),
      ),
    );
    const sendTurn = vi.fn();
    const user = userEvent.setup();
    const initial = session({ progress: { areas: areas({ tools: "skipped" }) } });
    render(<InterviewScreen initial={initial} api={apiWith({ sendControl, sendTurn })} />);
    await user.click(screen.getByRole("button", { name: /^Tools and systems/ }));
    await user.click(screen.getByRole("button", { name: "Come back to this" }));
    await waitFor(() => {
      expect(sendControl).toHaveBeenCalledWith({ type: "return_area", areaKey: "tools" }, expect.anything());
    });
    expect(sendTurn).not.toHaveBeenCalled();
  });
});

describe("I'm done", () => {
  it("sends one finish control after the question, and no 'I'm done' message", async () => {
    const sendControl = vi.fn(() =>
      Promise.resolve(sse([controlEvent("finish", undefined, "partial"), turnEvent("a2", "Anything else?")])),
    );
    const sendTurn = vi.fn();
    const user = userEvent.setup();
    render(<InterviewScreen initial={session()} api={apiWith({ sendControl, sendTurn })} />);

    await user.click(screen.getByRole("button", { name: "Interview options" }));
    await user.click(screen.getByRole("button", { name: "I'm done" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Finish" }));

    await waitFor(() => {
      expect(sendControl).toHaveBeenCalledTimes(1);
    });
    expect(sendControl).toHaveBeenCalledWith({ type: "finish" }, expect.anything());
    expect(sendTurn).not.toHaveBeenCalled();
    const list = await screen.findByRole("list", { name: "Conversation" });
    expect(await within(list).findByText("You asked to finish")).toBeInTheDocument();
    expect(within(list).getByText("Anything else?")).toBeInTheDocument();
  });
});

describe("the control SSE event", () => {
  it("parses kind, area and the progress after it", () => {
    const ev = toTurnStreamEvent({
      event: "control",
      data: JSON.stringify({
        kind: "skip_area",
        areaKey: "tools",
        at: "t",
        progress: { areas: areas({ tools: "skipped" }) },
      }),
    });
    expect(ev).toMatchObject({ type: "control", kind: "skip_area", areaKey: "tools" });
    expect(ev?.type === "control" ? ev.progress.areas[1]?.status : undefined).toBe("skipped");
  });

  it("reports an unknown kind as a malformed event rather than guessing", () => {
    const ev = toTurnStreamEvent({ event: "control", data: JSON.stringify({ kind: "explode" }) });
    expect(ev).toMatchObject({ type: "error", code: "malformed_event" });
  });
});

describe("a stray system message is not transcript", () => {
  it("only control chips are drawn from system messages", () => {
    render(
      <MessageList
        pending={false}
        streaming={null}
        messages={[
          { id: "s", seq: 1, role: "system", modality: "text", content: "internal note", createdAt: "" },
          {
            id: "control-1-skip_area-tools",
            seq: 0,
            role: "system",
            modality: "text",
            content: "",
            createdAt: "",
            control: { kind: "skip_area", areaKey: "tools", areaName: "Tools" },
          } as never,
        ]}
      />,
    );
    expect(screen.queryByText("internal note")).not.toBeInTheDocument();
    expect(screen.getByText("You skipped Tools")).toBeInTheDocument();
  });
});

describe("resume recap", () => {
  const recap = { text: "You covered your role. Next we will talk about tools.", source: "model" as const };

  it("shows the recap in a labelled region above the conversation, not as a message", async () => {
    render(<InterviewScreen initial={session({ recap })} api={apiWith()} />);

    const region = screen.getByRole("region", { name: "Where you left off" });
    expect(within(region).getByText(recap.text)).toBeInTheDocument();
    expect(document.activeElement).toBe(within(region).getByRole("heading", { name: "Where you left off" }));
    const list = screen.getByRole("list", { name: "Conversation" });
    expect(within(list).queryByText(recap.text)).not.toBeInTheDocument();
  });

  it("is dismissible, and Continue moves focus to the answer box", async () => {
    const user = userEvent.setup();
    render(<InterviewScreen initial={session({ recap })} api={apiWith()} />);
    await user.click(screen.getByRole("button", { name: "Hide this note" }));
    expect(screen.queryByRole("region", { name: "Where you left off" })).not.toBeInTheDocument();
  });

  it("Continue closes it and focuses the composer", async () => {
    const user = userEvent.setup();
    render(<InterviewScreen initial={session({ recap })} api={apiWith()} />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByRole("region", { name: "Where you left off" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("textbox"));
    });
  });

  it("is not shown when the API sent none, or once the interview is over", () => {
    const { unmount } = render(<InterviewScreen initial={session()} api={apiWith()} />);
    expect(screen.queryByRole("region", { name: "Where you left off" })).not.toBeInTheDocument();
    unmount();
    render(<InterviewScreen initial={session({ recap, status: "completed" })} api={apiWith()} />);
    expect(screen.queryByRole("region", { name: "Where you left off" })).not.toBeInTheDocument();
  });

  it("appears on the paused screen too, so pausing and reopening read the same", () => {
    render(<InterviewScreen initial={session({ recap, status: "paused" })} api={apiWith()} />);
    expect(screen.getByText("Interview paused")).toBeInTheDocument();
    expect(screen.getByText(recap.text)).toBeInTheDocument();
  });
});

describe("delete my data", () => {
  async function deleteIt(emailSent: boolean): Promise<void> {
    const user = userEvent.setup();
    render(
      <InterviewScreen
        initial={session()}
        api={apiWith({ deleteData: () => Promise.resolve({ ok: true, emailSent }) })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Interview options" }));
    await user.click(screen.getByRole("button", { name: "Delete my data" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Yes, delete my data" }),
    );
    await screen.findByText("Your answers were deleted");
  }

  it("says an email is on its way only when the API says one was queued", async () => {
    await deleteIt(true);
    expect(screen.getByText(en.participant.session.deletedEmailNote)).toBeInTheDocument();
  });

  it("promises no email otherwise", async () => {
    await deleteIt(false);
    expect(screen.queryByText(en.participant.session.deletedEmailNote)).not.toBeInTheDocument();
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
  });
});

describe("the strings the controls and the recap need, in both locales", () => {
  it.each([
    ["en", en],
    ["fi", fi],
  ] as const)("%s has them, and the unused recap strings are real words", (_name, strings) => {
    const s = strings.participant.session;
    expect(s.controlSkipped("X")).toContain("X");
    expect(s.controlReturned("X")).toContain("X");
    expect(s.skippedToast("X")).toContain("X");
    for (const text of [s.controlFinished, s.recapLabel, s.recapContinue, s.recapDismiss, s.newMessage])
      expect(text.trim().length).toBeGreaterThan(2);
  });
});

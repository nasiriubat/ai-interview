import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentList } from "@/components/participant/AttachmentList";
import { Composer } from "@/components/participant/Composer";
import { InterviewScreen } from "@/components/participant/InterviewScreen";
import { MessageBubble } from "@/components/participant/MessageList";
import { useAttachments, type AttachmentsOptions } from "@/hooks/useAttachments";
import { ApiError } from "@/lib/api/errors";
import { participantApi, type ParticipantApi } from "@/lib/api/participant";
import type { Attachment, SessionCapabilities } from "@/lib/api/schemas";

// The interview screen carries the language switch, which refreshes the route.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

/** Replaces the microphone for one test and reports whether its tracks were released. */
function microphone(getUserMedia?: () => Promise<unknown>): { asked: () => number; stopped: () => number } {
  const stop = vi.fn();
  const fallback = (): Promise<unknown> => Promise.resolve({ getTracks: () => [{ stop }] });
  const ask = vi.fn(getUserMedia ?? fallback);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: ask },
    writable: true,
    configurable: true,
  });
  return { asked: () => ask.mock.calls.length, stopped: () => stop.mock.calls.length };
}

function named(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

const attachment = (over: Partial<Attachment>): Attachment => ({
  id: "a1",
  kind: "document",
  filename: "handbook.pdf",
  mime: "application/pdf",
  sizeBytes: 2048,
  status: "ready",
  summary: null,
  error: null,
  durationMs: null,
  createdAt: "",
  ...over,
});

const options = (
  capabilities: Partial<SessionCapabilities> = {},
  initial: Attachment[] = [],
): AttachmentsOptions => ({
  initial,
  enabled: true,
  capabilities: {
    recordedVoice: true,
    liveVoice: false,
    captions: true,
    fileUpload: true,
    maxSizeMb: 20,
    allowedTypes: ["application/pdf", "text/markdown", "image/png"],
    ...capabilities,
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Composer recording", () => {
  it("asks for the microphone only when recording starts, then puts the words in the box and releases the device (D-483)", async () => {
    const mic = microphone();
    const onDictate = vi.fn((_audio: Blob, _durationMs: number) => Promise.resolve("I work nights"));
    const onSend = vi.fn(() => Promise.resolve(true));
    render(<Composer disabled={false} onSend={onSend} onDictate={onDictate} />);
    expect(mic.asked()).toBe(0);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Your answer"), "Nurse.");
    await user.click(screen.getByRole("button", { name: "Dictate your answer" }));
    expect(mic.asked()).toBe(1);
    expect(await screen.findByRole("timer", { name: "Recording, 0:00" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop and turn it into text" }));
    expect(onDictate).toHaveBeenCalledTimes(1);
    const [audio, durationMs] = onDictate.mock.calls[0] ?? [new Blob(), -1];
    expect(audio.size).toBeGreaterThan(0);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(mic.stopped()).toBe(1);

    // Added to what was typed, editable, and not sent.
    const box = screen.getByLabelText("Your answer");
    await waitFor(() => {
      expect(box).toHaveValue("Nurse. I work nights");
    });
    expect(onSend).not.toHaveBeenCalled();
    await user.type(box, ", mostly");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("Nurse. I work nights, mostly", "dictated");
  });

  it("shows why a dictation could not be turned into text, and keeps what was typed", async () => {
    microphone();
    const onDictate = vi.fn(() =>
      Promise.reject(new ApiError(400, "validation", "I could not hear anything in that recording")),
    );
    render(<Composer disabled={false} onSend={vi.fn()} onDictate={onDictate} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Your answer"), "Draft");
    await user.click(screen.getByRole("button", { name: "Dictate your answer" }));
    await user.click(await screen.findByRole("button", { name: "Stop and turn it into text" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Your answer")).toHaveValue("Draft");
  });

  it("discards a recording without transcribing it", async () => {
    const mic = microphone();
    const onDictate = vi.fn(() => Promise.resolve(""));
    render(<Composer disabled={false} onSend={vi.fn()} onDictate={onDictate} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Dictate your answer" }));
    await user.click(await screen.findByRole("button", { name: "Discard the recording" }));
    expect(onDictate).not.toHaveBeenCalled();
    expect(mic.stopped()).toBe(1);
  });

  it("explains a refused microphone and leaves typing available", async () => {
    microphone(() => Promise.reject(named("NotAllowedError")));
    const onSend = vi.fn();
    render(<Composer disabled={false} onSend={onSend} onDictate={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Dictate your answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Microphone access was blocked.");
    await user.type(screen.getByLabelText("Your answer"), "I typed it instead");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("I typed it instead", "text");
  });

  // On a phone the warning sat under the answer box for the rest of the interview (owner, 2026-10-21).
  it("lets the microphone warning be closed, and clears it once the person types", async () => {
    microphone(() => Promise.reject(named("NotAllowedError")));
    render(<Composer disabled={false} onSend={vi.fn()} onDictate={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Dictate your answer" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dictate your answer" }));
    await screen.findByRole("alert");
    await user.type(screen.getByLabelText("Your answer"), "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains a missing microphone differently from a refused one", async () => {
    microphone(() => Promise.reject(named("NotFoundError")));
    render(<Composer disabled={false} onSend={vi.fn()} onDictate={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Dictate your answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not find a microphone.");
  });

  it("explains a browser that cannot record without ever asking for the microphone", async () => {
    const mic = microphone();
    vi.stubGlobal("MediaRecorder", undefined);
    render(<Composer disabled={false} onSend={vi.fn()} onDictate={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Dictate your answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This browser cannot record audio.");
    expect(mic.asked()).toBe(0);
  });

  it("hides the microphone and the paperclip when the screen offers neither", () => {
    render(<Composer disabled={false} onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Dictate your answer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach a file" })).not.toBeInTheDocument();
  });
});

describe("attachments", () => {
  it("shows every status of a file on one line, and removes a file", async () => {
    const onRemove = vi.fn();
    render(
      <AttachmentList
        items={[
          attachment({ id: "p1", filename: "notes.md", status: "pending" }),
          attachment({ id: "r1", filename: "handbook.pdf", status: "ready" }),
          attachment({
            id: "f1",
            filename: "scan.png",
            kind: "image",
            status: "failed",
            error: "no_text",
          }),
          // A recording is not listed here: a spoken answer lives in its own bubble.
          attachment({ id: "v1", kind: "audio", filename: "recording.webm", durationMs: 7000 }),
        ]}
        uploading={false}
        error={null}
        onRemove={onRemove}
        fetchBytes={() => Promise.resolve(new Blob())}
      />,
    );

    expect(screen.getByText(/Reading your file…/)).toBeInTheDocument();
    expect(screen.getByText("2 kB · Ready")).toBeInTheDocument();
    // A code from the server, shown as a sentence the participant can act on (D-489).
    expect(screen.getByText(/No text found in this file/)).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText(/recording/i)).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Remove handbook.pdf" }));
    expect(onRemove).toHaveBeenCalledWith("r1");
  });

  it("plays a spoken answer from a blob URL inside its bubble, and lets go of it afterwards", async () => {
    const created = vi.spyOn(URL, "createObjectURL");
    const revoked = vi.spyOn(URL, "revokeObjectURL");
    const fetchBytes = vi.fn(() => Promise.resolve(new Blob(["audio"], { type: "audio/webm" })));
    const { unmount } = render(
      <MessageBubble
        message={{ id: "m9", role: "user", modality: "voice", content: "I run the night shift." }}
        clip={{
          state: "ready",
          source: {
            attachment: attachment({ id: "v1", kind: "audio", filename: "recording.webm", durationMs: 7000 }),
            fetchBytes,
          },
        }}
      />,
    );
    expect(screen.getByText("I run the night shift.")).toBeInTheDocument();
    expect(screen.getByText("0:07")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Play Your recording" }));
    await waitFor(() => {
      expect(created).toHaveBeenCalledTimes(1);
    });
    expect(fetchBytes).toHaveBeenCalledWith("v1");
    unmount();
    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it("says a recording is on its way, and offers the retry inside the bubble when it failed", async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <MessageBubble
        message={{ id: "local-1", role: "user", modality: "voice", content: "" }}
        clip={{ state: "sending" }}
      />,
    );
    expect(screen.getByText("Writing out what you said…")).toBeInTheDocument();
    rerender(
      <MessageBubble
        message={{ id: "local-1", role: "user", modality: "voice", content: "" }}
        clip={{ state: "failed", onRetry }}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when there is nothing to report", () => {
    const { container } = render(
      <AttachmentList
        items={[]}
        uploading={false}
        error={null}
        onRemove={vi.fn()}
        fetchBytes={() => Promise.resolve(new Blob())}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("refuses a file type this session does not allow, and accepts one it does", async () => {
    const uploadAttachment = vi.fn(() => Promise.resolve(attachment({})));
    const api = {
      listAttachments: () => Promise.resolve([]),
      uploadAttachment,
      deleteAttachment: () => Promise.resolve(),
      attachmentBytes: () => Promise.resolve(new Blob()),
    } as unknown as ParticipantApi;
    const { result } = renderHook(() => useAttachments(api, options()));
    act(() => {
      result.current.upload(new File(["MZ"], "tool.exe", { type: "application/x-msdownload" }));
    });
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(result.current.error).toContain("That kind of file cannot be read");

    // Markdown arrives with no media type of its own, so the extension has to carry it.
    await act(async () => {
      result.current.upload(new File(["# notes"], "notes.md", { type: "" }));
    });
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(result.current.error).toBeNull();
    });
  });

  it("follows the session's own allowed types rather than the shipped list", async () => {
    const uploadAttachment = vi.fn(() => Promise.resolve(attachment({})));
    const api = { uploadAttachment, listAttachments: () => Promise.resolve([]) } as unknown as ParticipantApi;
    const { result } = renderHook(() =>
      useAttachments(api, options({ allowedTypes: ["application/zip", "text/plain"] })),
    );
    expect(result.current.accept).toBe(".txt,application/zip,text/plain");

    // A type this tenant widened the setting to, which the shipped list never had.
    await act(async () => {
      result.current.upload(new File(["PK"], "export.zip", { type: "application/zip" }));
    });
    expect(uploadAttachment).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.upload(new File(["%PDF"], "handbook.pdf", { type: "application/pdf" }));
    });
    expect(uploadAttachment).toHaveBeenCalledTimes(1);
    expect(result.current.error).toContain("That kind of file cannot be read");
  });

  it("refuses an oversized file without uploading it, naming the limit", () => {
    const uploadAttachment = vi.fn(() => Promise.resolve(attachment({})));
    const api = { uploadAttachment, listAttachments: () => Promise.resolve([]) } as unknown as ParticipantApi;
    const { result } = renderHook(() => useAttachments(api, options({ maxSizeMb: 1 })));
    const big = new File(["x"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 2 * 1024 * 1024 });
    act(() => {
      result.current.upload(big);
    });
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(result.current.error).toBe("That file is too large. The most this interview takes is 1 MB.");
  });

  it("still explains a 413 from the API, since the limit can change after the page loads", async () => {
    const api = {
      listAttachments: () => Promise.resolve([]),
      uploadAttachment: () => Promise.reject(new ApiError(413, "too_large", "That file is too large")),
    } as unknown as ParticipantApi;
    const { result } = renderHook(() => useAttachments(api, options()));
    await act(async () => {
      result.current.upload(new File(["x"], "big.pdf", { type: "application/pdf" }));
    });
    await waitFor(() => {
      expect(result.current.error).toBe("That file is too large. Try a smaller one.");
    });
  });

  it("seeds the list from the session instead of fetching it", () => {
    const listAttachments = vi.fn(() => Promise.resolve([]));
    const api = { listAttachments } as unknown as ParticipantApi;
    const { result } = renderHook(() =>
      useAttachments(api, options({}, [attachment({ id: "seed1", filename: "seeded.pdf" })])),
    );
    expect(result.current.items.map((a) => a.id)).toEqual(["seed1"]);
    expect(listAttachments).not.toHaveBeenCalled();
  });

  it("picks a file through the composer's paperclip input", async () => {
    const onFile = vi.fn();
    const { container } = render(
      <Composer disabled={false} onSend={vi.fn()} onFile={onFile} accept=".pdf,application/pdf" />,
    );
    expect(screen.getByRole("button", { name: "Attach a file" })).toBeInTheDocument();
    const input = container.querySelector('input[type="file"]');
    expect(input).toHaveAttribute("accept", ".pdf,application/pdf");
    const file = new File(["hello"], "handbook.pdf", { type: "application/pdf" });
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });
});

describe("capabilities", () => {
  const session = (capabilities: Partial<SessionCapabilities>, modePreference?: "voice"): unknown => ({
    id: "s1",
    status: "active",
    consented: true,
    progress: { areas: [] },
    messages: [{ id: "a1", seq: 1, role: "assistant", modality: "text", content: "Hello", createdAt: "" }],
    attachments: [],
    ...(modePreference === undefined ? {} : { modePreference }),
    capabilities: {
      recordedVoice: true,
      liveVoice: false,
      captions: true,
      fileUpload: true,
      maxSizeMb: 20,
      allowedTypes: ["application/pdf"],
      ...capabilities,
    },
  });
  const api = {
    listAttachments: () => Promise.resolve([]),
    setMode: () => Promise.resolve(),
  } as unknown as ParticipantApi;

  it("offers the microphone, Talk and the paperclip when the session allows them", () => {
    render(<InterviewScreen initial={session({}) as never} api={api} />);
    expect(screen.getByRole("button", { name: "Dictate your answer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Talk" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach a file" })).toBeInTheDocument();
  });

  it("hides them when the tenant has voice or uploads turned off", () => {
    render(
      <InterviewScreen
        initial={session({ recordedVoice: false, fileUpload: false }, "voice") as never}
        api={api}
      />,
    );
    expect(screen.queryByRole("button", { name: "Dictate your answer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Talk" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach a file" })).not.toBeInTheDocument();
  });
});

describe("participant uploads", () => {
  it("posts one multipart part per upload and reads the attachment back", async () => {
    const seen: { path: string; body: FormData }[] = [];
    const api = participantApi({
      fetch: (path, init) => {
        seen.push({ path, body: init?.body as FormData });
        return Promise.resolve(
          new Response(JSON.stringify({ attachment: { id: "a9", kind: "document", filename: "x.pdf" } })),
        );
      },
    });
    const created = await api.uploadAttachment(new File(["x"], "x.pdf", { type: "application/pdf" }));
    expect(created.id).toBe("a9");
    expect(seen[0]?.path).toBe("/p/session/attachments");
    expect(seen[0]?.body.get("file")).toBeInstanceOf(File);

    await api.sendVoice(new Blob(["audio"], { type: "audio/webm;codecs=opus" }), 4200);
    expect(seen[1]?.path).toBe("/p/session/voice-turns");
    expect(seen[1]?.body.get("durationMs")).toBe("4200");
    const sent = seen[1]?.body.get("file");
    // The extension follows the container so the API's audio allowlist recognises it.
    expect(sent instanceof File ? sent.name : "").toBe("recording.webm");
  });
});

describe("a slow transcription says so (D-494)", () => {
  it("tells the person it is still working after a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    microphone();
    let finish!: (text: string) => void;
    const onDictate = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    render(<Composer disabled={false} onSend={vi.fn()} onDictate={onDictate} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    await user.click(screen.getByRole("button", { name: "Dictate your answer" }));
    await user.click(await screen.findByRole("button", { name: "Stop and turn it into text" }));
    const box = screen.getByLabelText("Your answer");
    expect(box).toHaveAttribute("placeholder", "Turning your recording into text…");
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(box.getAttribute("placeholder")).toMatch(/^Still turning your recording into text/);
    await act(async () => {
      finish("done");
    });
    await waitFor(() => {
      expect(box).toHaveValue("done");
    });
    vi.useRealTimers();
  });
});

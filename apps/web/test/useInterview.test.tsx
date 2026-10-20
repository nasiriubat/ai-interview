import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useInterview } from "@/hooks/useInterview";
import { ApiError } from "@/lib/api/errors";
import type { ParticipantApi } from "@/lib/api/participant";
import type { ParticipantSession } from "@/lib/api/schemas";

function sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const baseSession: ParticipantSession = {
  id: "s1",
  status: "active",
  consented: true,
  progress: { areas: [{ key: "role", name: "Role", status: "untouched" }] },
  messages: [],
  capabilities: {
    recordedVoice: true,
    liveVoice: false,
    captions: true,
    fileUpload: true,
    maxSizeMb: 20,
    allowedTypes: ["application/pdf"],
  },
  attachments: [],
};

function apiWith(sendTurn: ParticipantApi["sendTurn"], extra: Partial<ParticipantApi> = {}): ParticipantApi {
  const noop = (): Promise<void> => Promise.resolve();
  return {
    sendTurn,
    sendVoice: () => Promise.reject(new Error("unused")),
    transcribe: () => Promise.reject(new Error("unused")),
    uploadAttachment: () => Promise.reject(new Error("unused")),
    listAttachments: () => Promise.resolve([]),
    attachmentBytes: () => Promise.reject(new Error("unused")),
    deleteAttachment: noop,
    getLink: () => Promise.reject(new Error("unused")),
    requestCode: noop,
    confirmCode: () => Promise.reject(new Error("unused")),
    open: () => Promise.reject(new Error("unused")),
    getInvite: () => Promise.reject(new Error("unused")),
    openInvite: () => Promise.reject(new Error("unused")),
    getSession: () => Promise.resolve(baseSession),
    consent: noop,
    setPath: noop,
    setMode: noop,
    pause: noop,
    sendControl: () => Promise.reject(new Error("unused")),
    deleteData: () => Promise.resolve({ ok: true, emailSent: false }),
    getSummary: () => Promise.resolve({ summary: "", facts: [], status: "ready" as const }),
    putSummary: noop,
    ...extra,
  };
}

describe("useInterview", () => {
  it("sends the first empty turn on mount and streams the assistant message", async () => {
    const sendTurn = vi.fn((): Promise<Response> =>
      Promise.resolve(
        sse([
          'event: text\ndata: {"delta":"Hi "}\n\n',
          'event: text\ndata: {"delta":"there"}\n\n',
          'event: turn\ndata: {"message":{"id":"a1","seq":1,"role":"assistant","content":"Hi there","createdAt":""},"ended":false,"progress":{"areas":[{"key":"role","name":"Role","status":"partial"}]}}\n\n',
        ]),
      ),
    );
    const api = apiWith(sendTurn);
    const { result } = renderHook(() => useInterview(api, baseSession));
    // The first turn is deferred by a tick; wait for the request, then for the stream to finish.
    await waitFor(() => {
      expect(sendTurn).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.state.pending).toBe(false);
    });
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(sendTurn).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(result.current.state.messages.map((m) => m.content)).toEqual(["Hi there"]);
    expect(result.current.state.progress.areas[0]?.status).toBe("partial");
    expect(result.current.state.streaming).toBeNull();
  });

  it("adds an optimistic user message and exposes the widget of the last turn", async () => {
    const sendTurn = vi.fn((): Promise<Response> =>
      Promise.resolve(
        sse([
          'event: turn\ndata: {"message":{"id":"a2","seq":3,"role":"assistant","content":"Pick one","widget":{"type":"yes_no"},"createdAt":""},"ended":false,"progress":{"areas":[]}}\n\n',
        ]),
      ),
    );
    const initial: ParticipantSession = {
      ...baseSession,
      messages: [{ id: "a1", seq: 1, role: "assistant", modality: "text", content: "Hello", createdAt: "" }],
    };
    const api = apiWith(sendTurn);
    const { result } = renderHook(() => useInterview(api, initial));
    expect(sendTurn).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.sendText("I am a nurse");
    });
    const contents = result.current.state.messages.map((m) => m.content);
    expect(contents).toEqual(["Hello", "I am a nurse", "Pick one"]);
    expect(result.current.activeWidget).toEqual({ type: "yes_no" });
  });

  it("shows the transcript of a recording as the participant's own turn before the reply", async () => {
    const sendVoice = vi.fn((): Promise<Response> =>
      Promise.resolve(
        sse([
          'event: transcript\ndata: {"text":"We chase invoices by hand","attachmentId":"att1","confidence":0.9}\n\n',
          'event: turn\ndata: {"message":{"id":"u1","seq":2,"role":"user","modality":"voice","content":"We chase invoices by hand","createdAt":""},"ended":false,"progress":{"areas":[]}}\n\n',
          'event: turn\ndata: {"message":{"id":"a2","seq":3,"role":"assistant","content":"How often?","createdAt":""},"ended":false,"progress":{"areas":[]}}\n\n',
        ]),
      ),
    );
    const initial: ParticipantSession = {
      ...baseSession,
      messages: [{ id: "a1", seq: 1, role: "assistant", modality: "text", content: "Hello", createdAt: "" }],
    };
    const api = apiWith(() => Promise.reject(new Error("unused")), { sendVoice });
    const { result } = renderHook(() => useInterview(api, initial));
    const audio = new Blob(["audio"], { type: "audio/webm" });
    await act(async () => {
      await result.current.sendVoice(audio, 4200);
    });
    expect(sendVoice).toHaveBeenCalledWith(audio, 4200, expect.any(AbortSignal));
    expect(result.current.state.messages.map((m) => m.content)).toEqual([
      "Hello",
      "We chase invoices by hand",
      "How often?",
    ]);
    // The server's own copy replaced the transcript rather than appearing beside it.
    const spoken = result.current.state.messages[1];
    expect(spoken).toMatchObject({ id: "u1", role: "user", modality: "voice" });
  });

  it("surfaces stream errors and ends the interview on the ended event", async () => {
    const sendTurn = vi.fn((): Promise<Response> =>
      Promise.resolve(
        sse([
          'event: error\ndata: {"code":"budget_exceeded","message":"Budget reached"}\n\n',
          'event: ended\ndata: {"summaryAvailable":true}\n\n',
        ]),
      ),
    );
    const api = apiWith(sendTurn);
    const { result } = renderHook(() => useInterview(api, baseSession));
    // The first turn is deferred by a tick; wait for the request, then for the stream to finish.
    await waitFor(() => {
      expect(sendTurn).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.state.pending).toBe(false);
    });
    expect(result.current.state.error).toEqual({ code: "budget_exceeded", message: "Budget reached" });
    expect(result.current.state.ended).toBe(true);
    expect(result.current.state.summaryAvailable).toBe(true);
  });

  it("hands the spec event of a requirements turn to onSpec without touching the messages", async () => {
    const spec = {
      title: "Booking app",
      path: "technical",
      context: { users: "Clinic staff" },
      sections: [{ key: "overview", title: "Overview", status: "draft", markdown: "# Overview", fields: [] }],
      findings: [],
      decisions: [],
      mvpChallenge: { started: false, done: false, asked: [], outcome: "pending" },
      stats: { fields: 1, sectionsWithContent: 1, openFindings: 0 },
    };
    const sendTurn = vi.fn((): Promise<Response> =>
      Promise.resolve(
        sse([
          'event: turn\ndata: {"message":{"id":"a2","seq":3,"role":"assistant","content":"Next?","createdAt":""},"ended":false,"progress":{"areas":[]}}\n\n',
          `event: spec\ndata: ${JSON.stringify({ spec })}\n\n`,
        ]),
      ),
    );
    const onSpec = vi.fn();
    const initial: ParticipantSession = {
      ...baseSession,
      messages: [{ id: "a1", seq: 1, role: "assistant", modality: "text", content: "Hello", createdAt: "" }],
    };
    const { result } = renderHook(() => useInterview(apiWith(sendTurn), initial, { onSpec }));
    await act(async () => {
      await result.current.sendText("A booking app for clinics");
    });
    expect(onSpec).toHaveBeenCalledTimes(1);
    expect(onSpec.mock.calls[0]?.[0]).toMatchObject({ title: "Booking app", stats: { fields: 1 } });
    expect(result.current.state.messages.map((m) => m.content)).toEqual([
      "Hello",
      "A booking app for clinics",
      "Next?",
    ]);
    expect(result.current.state.error).toBeNull();
  });
});

/**
 * The owner's voice report (2026-10-20): after a few spoken answers one failed, the participant's
 * earlier answers vanished from the conversation, and recording again kept failing.
 *
 * These follow the real server, which never echoes the participant's own message back: every
 * answer given in this visit keeps its client-side `local-` id until the page is reloaded.
 */
describe("useInterview: recovering from a failed answer", () => {
  const question = (id: string, content: string): string =>
    `event: turn\ndata: ${JSON.stringify({
      message: { id, seq: 1, role: "assistant", content, createdAt: "" },
      ended: false,
      progress: { areas: [] },
    })}\n\n`;
  const opened: ParticipantSession = {
    ...baseSession,
    messages: [{ id: "q1", seq: 1, role: "assistant", modality: "text", content: "Q1", createdAt: "" }],
  };

  /** A stream the test finishes by hand, to hold a turn open. */
  function heldStream(): { response: Response; finish: (chunks: string[]) => void } {
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return {
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      finish: (chunks) => {
        if (closed) return;
        closed = true;
        for (const ch of chunks) controller.enqueue(enc.encode(ch));
        controller.close();
      },
    };
  }

  it("keeps every earlier answer when a failed one is retried", async () => {
    let n = 0;
    const sendTurn = vi.fn((): Promise<Response> => {
      n++;
      if (n === 3) return Promise.reject(new ApiError(409, "conflict", "A turn is already in progress"));
      return Promise.resolve(sse([question(`q${String(n + 1)}`, `Q${String(n + 1)}`)]));
    });
    const { result } = renderHook(() => useInterview(apiWith(sendTurn), opened));
    await act(async () => {
      await result.current.sendText("first answer");
    });
    await act(async () => {
      await result.current.sendText("second answer");
    });
    await act(async () => {
      await result.current.sendText("third answer");
    });
    expect(result.current.state.error?.code).toBe("conflict");
    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.messages.map((m) => m.content)).toEqual([
      "Q1",
      "first answer",
      "Q2",
      "second answer",
      "Q3",
      "third answer",
      "Q5",
    ]);
  });

  it("keeps every earlier answer when the next one is sent after a failure", async () => {
    let n = 0;
    const sendTurn = vi.fn((): Promise<Response> => {
      n++;
      if (n === 2) return Promise.reject(new ApiError(500, "server_error", "boom"));
      return Promise.resolve(sse([question(`q${String(n + 1)}`, `Q${String(n + 1)}`)]));
    });
    const { result } = renderHook(() => useInterview(apiWith(sendTurn), opened));
    await act(async () => {
      await result.current.sendText("first answer");
    });
    await act(async () => {
      await result.current.sendText("lost answer");
    });
    await act(async () => {
      await result.current.sendText("second try");
    });
    expect(result.current.state.messages.map((m) => m.content)).toEqual([
      "Q1",
      "first answer",
      "Q2",
      "second try",
      "Q4",
    ]);
  });

  it("does not cut off a turn in flight when a recording is sent: it waits for it", async () => {
    const first = heldStream();
    const sendTurn = vi.fn((_input: unknown, signal?: AbortSignal): Promise<Response> => {
      signal?.addEventListener("abort", () => {
        first.finish([]);
      });
      return Promise.resolve(first.response);
    });
    const sendVoice = vi.fn((): Promise<Response> =>
      Promise.resolve(
        sse([
          'event: transcript\ndata: {"text":"spoken answer","attachmentId":"att1"}\n\n',
          question("q3", "Q3"),
        ]),
      ),
    );
    const { result } = renderHook(() => useInterview(apiWith(sendTurn, { sendVoice }), opened));
    let typed!: Promise<boolean>;
    act(() => {
      typed = result.current.sendText("typed answer");
    });
    await waitFor(() => {
      expect(sendTurn).toHaveBeenCalledTimes(1);
    });
    // The interviewer is still replying when the participant records the next answer.
    let spoken!: Promise<boolean>;
    act(() => {
      spoken = result.current.sendVoice(new Blob(["wav"], { type: "audio/wav" }), 1500);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(sendVoice).not.toHaveBeenCalled();
    await act(async () => {
      first.finish([question("q2", "Q2")]);
      await typed;
      await spoken;
    });
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.messages.map((m) => m.content)).toEqual([
      "Q1",
      "typed answer",
      "Q2",
      "spoken answer",
      "Q3",
    ]);
  });

  it("asks for a new recording, not a resend of the same one, when nothing was heard", async () => {
    const sendVoice = vi.fn((): Promise<Response> =>
      Promise.reject(
        new ApiError(400, "validation", "I could not hear anything in that recording", {
          reason: "no_speech",
        }),
      ),
    );
    const { result } = renderHook(() => useInterview(apiWith(vi.fn(), { sendVoice }), opened));
    await act(async () => {
      await result.current.sendVoice(new Blob(["wav"], { type: "audio/wav" }), 900);
    });
    expect(result.current.state.error?.code).toBe("not_heard");
    // No empty "could not be sent" bubble whose retry would only send the same silence again.
    expect(result.current.state.messages.map((m) => m.content)).toEqual(["Q1"]);
    await act(async () => {
      await result.current.retry();
    });
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(result.current.state.error).toBeNull();
  });

  it("does not answer a failed live-call turn with an empty HTTP turn on retry", async () => {
    const sendTurn = vi.fn((): Promise<Response> => Promise.resolve(sse([question("qx", "QX")])));
    const { result } = renderHook(() => useInterview(apiWith(sendTurn), opened));
    act(() => {
      result.current.live.heard("spoken over the call");
      result.current.live.failed("provider_error", "The assistant is temporarily unavailable.");
    });
    await act(async () => {
      await result.current.retry();
    });
    expect(sendTurn).not.toHaveBeenCalled();
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.messages.map((m) => m.content)).toEqual(["Q1", "spoken over the call"]);
  });
});

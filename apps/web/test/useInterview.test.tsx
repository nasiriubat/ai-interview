import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useInterview } from "@/hooks/useInterview";
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
  capabilities: { recordedVoice: true, fileUpload: true, maxSizeMb: 20, allowedTypes: ["application/pdf"] },
  attachments: [],
};

function apiWith(sendTurn: ParticipantApi["sendTurn"], extra: Partial<ParticipantApi> = {}): ParticipantApi {
  const noop = (): Promise<void> => Promise.resolve();
  return {
    sendTurn,
    sendVoice: () => Promise.reject(new Error("unused")),
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
    complete: noop,
    deleteData: noop,
    getSummary: () => Promise.resolve({ summary: "", facts: [] }),
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
      mvpChallenge: { started: false, done: false, asked: [] },
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

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnStatus, turnPhase, useFocusOnTurn, type TurnPhase } from "@/components/participant/TurnStatus";
import { useInterview } from "@/hooks/useInterview";
import { t } from "@/i18n";
import { participantApi } from "@/lib/api/participant";
import type { ParticipantSession } from "@/lib/api/schemas";
import { toTurnStreamEvent } from "@/lib/api/sse";

const session: ParticipantSession = {
  id: "s1",
  status: "active",
  consented: true,
  progress: { areas: [] },
  messages: [{ id: "a1", seq: 1, role: "assistant", modality: "text", content: "Hello", createdAt: "" }],
  capabilities: {
    recordedVoice: false,
    liveVoice: false,
    captions: false,
    fileUpload: false,
    maxSizeMb: 20,
    allowedTypes: [],
  },
  attachments: [],
};

/** A turn stream the test feeds one event at a time, so the state between events can be seen. */
function controlledStream(): { response: Response; push: (event: string) => void; close: () => void } {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    push: (event) => {
      ctrl.enqueue(enc.encode(event));
    },
    close: () => {
      ctrl.close();
    },
  };
}

describe("turn phases (D-481)", () => {
  const base = { pending: false, streaming: null, composing: false, ended: false, error: null };

  it("reads waiting, writing, preparing and the person's turn from the interview state", () => {
    expect(turnPhase({ ...base, pending: true })).toBe("thinking");
    expect(turnPhase({ ...base, pending: true, streaming: "Wh" })).toBe("writing");
    expect(turnPhase({ ...base, pending: true, streaming: "What?", composing: true })).toBe("preparing");
    expect(turnPhase(base)).toBe("answer");
    expect(turnPhase({ ...base, ended: true })).toBe("idle");
    expect(turnPhase({ ...base, error: { code: "x", message: "" } })).toBe("idle");
  });

  it("parses the composing event", () => {
    expect(toTurnStreamEvent({ event: "composing", data: "{}" })).toEqual({ type: "composing" });
  });

  it("marks the turn as composing between the finished text and the turn event", async () => {
    const stream = controlledStream();
    // The real client over a transport that answers the turn with the controlled stream.
    const api = participantApi({ fetch: () => Promise.resolve(stream.response) });
    const { result } = renderHook(() => useInterview(api, session));
    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.sendText("A nurse");
    });
    await act(async () => {
      stream.push('event: text\ndata: {"delta":"How long?"}\n\n');
      stream.push("event: composing\ndata: {}\n\n");
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(turnPhase(result.current.state)).toBe("preparing");
    });
    await act(async () => {
      stream.push(
        'event: turn\ndata: {"message":{"id":"a2","seq":3,"role":"assistant","content":"How long?","createdAt":""},"ended":false,"progress":{"areas":[]}}\n\n',
      );
      stream.close();
      await sent;
    });
    expect(turnPhase(result.current.state)).toBe("answer");
  });
});

describe("TurnStatus", () => {
  const s = t.participant.session.turnStatus;

  it("says whose turn it is, and how to answer", () => {
    const { rerender } = render(<TurnStatus phase="preparing" widget={false} />);
    expect(screen.getByText(s.preparing)).toBeTruthy();
    rerender(<TurnStatus phase="answer" widget />);
    expect(screen.getByText(s.pick)).toBeTruthy();
    rerender(<TurnStatus phase="answer" widget={false} canDictate />);
    expect(screen.getByText(s.typeOrDictate)).toBeTruthy();
    rerender(<TurnStatus phase="answer" widget={false} />);
    expect(screen.getByText(s.type)).toBeTruthy();
  });
});

describe("useFocusOnTurn", () => {
  function run(
    phases: TurnPhase[],
    opts: { widget?: boolean; coarse?: boolean } = {},
  ): ReturnType<typeof vi.fn> {
    const focus = vi.fn();
    const { rerender } = renderHook(
      ({ phase }: { phase: TurnPhase }) => {
        useFocusOnTurn(phase, opts.widget ?? false, opts.coarse ?? false, focus);
      },
      { initialProps: { phase: phases[0] ?? "thinking" } },
    );
    for (const phase of phases.slice(1)) rerender({ phase });
    return focus;
  }

  it("focuses the box when a question without options arrives", () => {
    expect(run(["thinking", "writing", "answer"])).toHaveBeenCalledTimes(1);
  });

  it("leaves focus alone for options, on touch screens, and when focus is elsewhere", () => {
    expect(run(["writing", "answer"], { widget: true })).not.toHaveBeenCalled();
    expect(run(["writing", "answer"], { coarse: true })).not.toHaveBeenCalled();
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(run(["writing", "answer"])).not.toHaveBeenCalled();
    elsewhere.remove();
  });
});

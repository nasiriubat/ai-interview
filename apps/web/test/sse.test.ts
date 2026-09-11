import { describe, expect, it } from "vitest";
import { parseSse, readTurnStream, toTurnStreamEvent, type TurnStreamEvent } from "@/lib/api/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("parseSse", () => {
  it("parses events split across chunks with \\n and \\r\\n endings", async () => {
    const events = await collect(
      parseSse(
        streamOf(['event: text\ndata: {"delta":"He', 'llo"}\n\n', 'event: turn\r\ndata: {"a":1}\r\n\r\n']),
      ),
    );
    expect(events).toEqual([
      { event: "text", data: '{"delta":"Hello"}' },
      { event: "turn", data: '{"a":1}' },
    ]);
  });

  it("joins multi-line data, ignores comments, and flushes a trailing event without a blank line", async () => {
    const events = await collect(
      parseSse(streamOf([": keep-alive\n", "id: 7\nevent: x\ndata: a\ndata: b\n"])),
    );
    expect(events).toEqual([{ event: "x", data: "a\nb", id: "7" }]);
  });

  it("defaults the event name to message and skips empty data", async () => {
    const events = await collect(parseSse(streamOf(["data: 1\n\n", "event: nothing\n\n", "data: 2\n\n"])));
    expect(events.map((e) => [e.event, e.data])).toEqual([
      ["message", "1"],
      ["message", "2"],
    ]);
  });
});

describe("toTurnStreamEvent", () => {
  it("maps the four contract events", () => {
    expect(toTurnStreamEvent({ event: "text", data: '{"delta":"x"}' })).toEqual({ type: "text", delta: "x" });
    expect(toTurnStreamEvent({ event: "ended", data: '{"summaryAvailable":true}' })).toEqual({
      type: "ended",
      summaryAvailable: true,
    });
    expect(
      toTurnStreamEvent({ event: "error", data: '{"code":"budget_exceeded","message":"stop"}' }),
    ).toEqual({
      type: "error",
      code: "budget_exceeded",
      message: "stop",
    });
    const turn = toTurnStreamEvent({
      event: "turn",
      data: JSON.stringify({
        message: {
          id: "m1",
          seq: 2,
          role: "assistant",
          modality: "text",
          content: "Hi",
          createdAt: "2026-01-01",
        },
        ended: false,
        progress: { areas: [{ key: "role", name: "Role", status: "partial" }] },
      }),
    });
    expect(turn?.type).toBe("turn");
    if (turn?.type === "turn") {
      expect(turn.message.content).toBe("Hi");
      expect(turn.progress.areas[0]?.status).toBe("partial");
    }
  });

  it("maps the spec event of a requirements turn (contract 18) and fills its defaults", () => {
    const ev = toTurnStreamEvent({
      event: "spec",
      data: JSON.stringify({
        spec: {
          title: "Booking app",
          path: null,
          context: {},
          sections: [{ key: "overview", title: "Overview", status: "empty", markdown: "", fields: [] }],
          findings: [
            {
              id: "f1",
              type: "ambiguity",
              section: "users",
              description: "Who books?",
              resolution: "Name the roles",
              default: "Staff only",
            },
          ],
          decisions: [],
        },
      }),
    });
    expect(ev?.type).toBe("spec");
    if (ev?.type === "spec") {
      expect(ev.spec.sections[0]?.key).toBe("overview");
      expect(ev.spec.findings[0]).toMatchObject({ status: "open", confidence: "medium", pushedBack: false });
      expect(ev.spec.mvpChallenge).toEqual({ started: false, done: false, asked: [] });
      expect(ev.spec.stats).toEqual({ fields: 0, sectionsWithContent: 0, openFindings: 0 });
    }
    expect(toTurnStreamEvent({ event: "spec", data: '{"spec":{"sections":"nope"}}' })).toMatchObject({
      type: "error",
      code: "malformed_event",
    });
  });

  it("ignores unknown events and reports malformed payloads as errors", () => {
    expect(toTurnStreamEvent({ event: "ping", data: "{}" })).toBeUndefined();
    expect(toTurnStreamEvent({ event: "text", data: "not json" })).toEqual({
      type: "error",
      code: "malformed_event",
      message: expect.stringContaining("text") as string,
    });
  });
});

describe("readTurnStream", () => {
  it("yields typed events from a Response", async () => {
    const body = streamOf([
      'event: text\ndata: {"delta":"Hel"}\n\n',
      'event: text\ndata: {"delta":"lo"}\n\n',
      'event: turn\ndata: {"message":{"id":"m","seq":1,"role":"assistant","content":"Hello","createdAt":""},"ended":true,"progress":{"areas":[]}}\n\n',
      'event: ended\ndata: {"summaryAvailable":false}\n\n',
    ]);
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const events: TurnStreamEvent[] = await collect(readTurnStream(res));
    expect(events.map((e) => e.type)).toEqual(["text", "text", "turn", "ended"]);
  });

  it("reports a missing body", async () => {
    const events = await collect(readTurnStream(new Response(null)));
    expect(events[0]?.type).toBe("error");
  });
});

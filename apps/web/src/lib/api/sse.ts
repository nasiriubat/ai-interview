import { z } from "zod";
import { LiveSpecSchema, MessageSchema, ProgressSchema } from "./schemas";

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Parses a `text/event-stream` body into events. Handles `\n` and `\r\n` line endings,
 * multi-line `data:` fields, comments, and a final event without a trailing blank line.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let dataLines: string[] = [];
  let id: string | undefined;

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      event = "message";
      return undefined;
    }
    const out: SseEvent = { event, data: dataLines.join("\n"), ...(id !== undefined ? { id } : {}) };
    event = "message";
    dataLines = [];
    return out;
  };

  const handleLine = (line: string): SseEvent | undefined => {
    if (line === "") return flush();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        id = value;
        break;
      default:
        break;
    }
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.search(/\r?\n/);
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer[nl] === "\r" ? 2 : 1));
        const ev = handleLine(line);
        if (ev) yield ev;
        nl = buffer.search(/\r?\n/);
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const ev = handleLine(buffer);
      if (ev) yield ev;
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

const TextEventSchema = z.object({ delta: z.string() });
const TurnEventSchema = z.object({
  message: MessageSchema,
  ended: z.boolean().default(false),
  progress: ProgressSchema.default({ areas: [] }),
});
const EndedEventSchema = z.object({ summaryAvailable: z.boolean().default(false) });
const ErrorEventSchema = z.object({ code: z.string().default("error"), message: z.string().default("") });
/** Contract 18: the live spec re-rendered after each turn of a requirements session. */
const SpecEventSchema = z.object({ spec: LiveSpecSchema });
/** FR-30: what a recording was heard as, sent before the interviewer answers it. */
const TranscriptEventSchema = z.object({
  text: z.string(),
  attachmentId: z.string(),
  confidence: z.number().optional(),
  durationMs: z.number().optional(),
});

/**
 * A participant control the engine applied (skip, return, finish), sent before the interviewer's
 * turn. `progress` is the state after it, so the chips move at once.
 */
const ControlEventSchema = z.object({
  kind: z.enum(["skip_area", "return_area", "finish"]),
  areaKey: z.string().optional(),
  at: z.string().default(""),
  progress: ProgressSchema.default({ areas: [] }),
});

export type TurnStreamEvent =
  | { type: "text"; delta: string }
  | {
      type: "control";
      kind: "skip_area" | "return_area" | "finish";
      areaKey?: string | undefined;
      at: string;
      progress: z.infer<typeof ProgressSchema>;
    }
  | {
      type: "turn";
      message: z.infer<typeof MessageSchema>;
      ended: boolean;
      progress: z.infer<typeof ProgressSchema>;
    }
  | { type: "ended"; summaryAvailable: boolean }
  | { type: "spec"; spec: z.infer<typeof LiveSpecSchema> }
  | {
      type: "transcript";
      text: string;
      attachmentId: string;
      confidence?: number | undefined;
      durationMs?: number | undefined;
    }
  | { type: "error"; code: string; message: string };

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** Turns a raw SSE event from `POST /p/session/turns` into a typed event, or `undefined` for unknown events. */
export function toTurnStreamEvent(ev: SseEvent): TurnStreamEvent | undefined {
  const json = parseJson(ev.data);
  switch (ev.event) {
    case "text": {
      const r = TextEventSchema.safeParse(json);
      return r.success ? { type: "text", delta: r.data.delta } : malformed(ev);
    }
    case "control": {
      const r = ControlEventSchema.safeParse(json);
      return r.success ? { type: "control", ...r.data } : malformed(ev);
    }
    case "turn": {
      const r = TurnEventSchema.safeParse(json);
      return r.success ? { type: "turn", ...r.data } : malformed(ev);
    }
    case "ended": {
      const r = EndedEventSchema.safeParse(json);
      return r.success ? { type: "ended", summaryAvailable: r.data.summaryAvailable } : malformed(ev);
    }
    case "error": {
      const r = ErrorEventSchema.safeParse(json);
      return r.success ? { type: "error", code: r.data.code, message: r.data.message } : malformed(ev);
    }
    case "spec": {
      const r = SpecEventSchema.safeParse(json);
      return r.success ? { type: "spec", spec: r.data.spec } : malformed(ev);
    }
    case "transcript": {
      const r = TranscriptEventSchema.safeParse(json);
      return r.success ? { type: "transcript", ...r.data } : malformed(ev);
    }
    default:
      return undefined;
  }
}

function malformed(ev: SseEvent): TurnStreamEvent {
  return { type: "error", code: "malformed_event", message: `Could not read a "${ev.event}" event` };
}

/** Reads the SSE response of a turn and yields typed events until the stream ends. */
export async function* readTurnStream(res: Response): AsyncGenerator<TurnStreamEvent> {
  if (!res.body) {
    yield { type: "error", code: "empty_stream", message: "The server returned no stream" };
    return;
  }
  for await (const ev of parseSse(res.body)) {
    const typed = toTurnStreamEvent(ev);
    if (typed) yield typed;
  }
}

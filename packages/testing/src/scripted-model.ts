import type { CallContext, CallRequest, ModelCallerPort } from "@aidp/ai";
import type { ChatEvent, Purpose } from "@aidp/shared";
import type { z } from "zod";

/** One scripted answer: the text to return, or an error to throw when that call is made. */
export type ScriptedResponse = string | Error;

export interface RecordedCall {
  purpose: Purpose;
  ctx: CallContext;
  req: CallRequest;
}

/**
 * A model that answers from a list, for tests that need the whole stack except the network.
 *
 * Each `chat` or `complete` takes the next response. `complete` parses the response through the
 * schema the caller passed, so a fake cannot return something the real schema would reject. A
 * response that is an `Error` is thrown instead, which is how a test makes batch two of three
 * fail.
 *
 * Implements `ModelCallerPort`, so no cast is needed anywhere it is handed to the engine.
 */
export class ScriptedModel implements ModelCallerPort {
  readonly calls: RecordedCall[] = [];
  private readonly queue: ScriptedResponse[];
  private fallback: string;

  constructor(responses: ScriptedResponse[] = [], fallback = "{}") {
    this.queue = [...responses];
    this.fallback = fallback;
  }

  /** Appends responses after the ones already queued. */
  enqueue(...responses: ScriptedResponse[]): void {
    this.queue.push(...responses);
  }

  /** Calls made so far for one purpose. */
  callsFor(purpose: Purpose): RecordedCall[] {
    return this.calls.filter((c) => c.purpose === purpose);
  }

  private next(): string {
    const r = this.queue.shift() ?? this.fallback;
    if (r instanceof Error) throw r;
    return r;
  }

  async *chat(purpose: Purpose, ctx: CallContext, req: CallRequest): AsyncIterable<ChatEvent> {
    this.calls.push({ purpose, ctx, req });
    const text = this.next();
    // Awkward chunk boundaries on purpose: the turn parser has to cope with them.
    for (let i = 0; i < text.length; i += 7) yield { type: "text", text: text.slice(i, i + 7) };
    yield {
      type: "done",
      usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 },
      stopReason: "end_turn",
      model: "scripted",
    };
  }

  async complete<T>(purpose: Purpose, ctx: CallContext, req: CallRequest, schema: z.ZodType<T>): Promise<T> {
    this.calls.push({ purpose, ctx, req });
    return schema.parse(JSON.parse(this.next()));
  }

  async embed(): Promise<undefined> {
    return undefined;
  }
}

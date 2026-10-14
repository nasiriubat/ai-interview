import type {
  ChatEvent,
  InterviewTemplate,
  InterviewTemplateInput,
  Purpose,
  SessionState,
} from "@aidp/shared";
import { InterviewTemplateSchema, SessionStateSchema } from "@aidp/shared";
import type { z } from "zod";
import type { CallContext, CallRequest, ModelCallerPort } from "../../src/callModel.js";
import type {
  ExtractionCommit,
  NewMessage,
  SessionSnapshot,
  SessionStore,
  StoredMessage,
} from "../../src/engine/ports.js";
import { reconcileBackgroundProgress } from "../../src/engine/state.js";

export class MemoryStore implements SessionStore {
  messages: StoredMessage[] = [];
  states: SessionState[] = [];
  summaries: string[] = [];
  events: { type: string; payload: unknown }[] = [];
  async appendMessage(_id: string, m: NewMessage): Promise<StoredMessage> {
    const stored: StoredMessage = {
      ...m,
      id: `m${this.messages.length + 1}`,
      seq: this.messages.length + 1,
      createdAt: new Date(),
    };
    this.messages.push(stored);
    return stored;
  }
  async recentMessages(_id: string, limit: number): Promise<StoredMessage[]> {
    return this.messages.slice(-limit);
  }
  async messagesAfter(_id: string, seq: number): Promise<StoredMessage[]> {
    return this.messages.filter((m) => m.seq > seq);
  }
  async saveState(_id: string, state: SessionState): Promise<void> {
    this.states.push(reconcileBackgroundProgress(this.state, state));
  }
  async commitSummary(_id: string, summary: string, upToSeq: number): Promise<void> {
    this.summaries.push(summary);
    this.states.push({ ...this.state, summaryUpToSeq: Math.max(this.state.summaryUpToSeq, upToSeq) });
  }
  async commitExtraction(_id: string, c: ExtractionCommit): Promise<"committed" | "stale"> {
    if (this.state.lastExtractedSeq !== c.fromSeq) return "stale";
    this.states.push({
      ...this.state,
      facts: [...this.state.facts, ...c.facts],
      lastExtractedSeq: c.toSeq,
    });
    this.events.push({ type: "facts_extracted", payload: c.event });
    return "committed";
  }
  async appendEvent(_id: string, type: string, payload: unknown): Promise<void> {
    this.events.push({ type, payload });
  }
  get state(): SessionState {
    return this.states[this.states.length - 1] ?? SessionStateSchema.parse({});
  }
}

/** Scripted model: each call pops the next response; records requests. */
export class ScriptedCaller implements ModelCallerPort {
  requests: { purpose: string; req: CallRequest }[] = [];
  constructor(private responses: string[]) {}
  async *chat(purpose: Purpose, _ctx: CallContext, req: CallRequest): AsyncIterable<ChatEvent> {
    this.requests.push({ purpose, req });
    const text = this.responses.shift() ?? "I have nothing more to ask.\n<<<TURN_META>>>\n{}";
    // stream in awkward chunks to exercise the parser
    for (let i = 0; i < text.length; i += 7) yield { type: "text", text: text.slice(i, i + 7) };
    yield {
      type: "done",
      usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 },
      stopReason: "end_turn",
      model: "fake",
    };
  }
  async complete<T>(purpose: Purpose, _ctx: CallContext, req: CallRequest, schema: z.ZodType<T>): Promise<T> {
    this.requests.push({ purpose, req });
    return schema.parse(JSON.parse(this.responses.shift() ?? "{}"));
  }
  async embed(): Promise<undefined> {
    return undefined;
  }
  asCaller(): ModelCallerPort {
    return this;
  }
}

export const template = (over: Partial<InterviewTemplateInput> = {}): InterviewTemplate =>
  InterviewTemplateSchema.parse({
    key: "t",
    version: 1,
    name: "Test",
    objective: "Understand the work.",
    privacyMode: "anonymous",
    coverageAreas: [
      {
        key: "role",
        name: "Role",
        description: "Role.",
        doneWhen: "Role known.",
        essential: true,
        maxFollowUps: 1,
      },
      {
        key: "daily",
        name: "Daily",
        description: "Daily work.",
        doneWhen: "Activities known.",
        maxFollowUps: 2,
      },
      {
        key: "problems",
        name: "Problems",
        description: "Problems.",
        doneWhen: "Problems known.",
        essential: true,
      },
    ],
    outputs: ["task", "pain_point"],
    ...over,
  });

export const snapshot = (
  t: InterviewTemplate,
  // What the schema accepts, so a test may name a coverage entry by its status alone.
  state: object = {},
  summary = "",
): SessionSnapshot => ({
  id: "s1",
  companyId: "c1",
  template: t,
  state: SessionStateSchema.parse(state),
  summary,
});

export const settings = {
  recentWindowTurns: 10,
  inputTokenBudget: 12000,
  summarizeEveryTurns: 6,
  extractEveryTurns: 3,
  maxTurns: 60,
};

export const turn = (message: string, meta: Record<string, unknown> = {}): string =>
  `${message}\n<<<TURN_META>>>\n${JSON.stringify(meta)}`;

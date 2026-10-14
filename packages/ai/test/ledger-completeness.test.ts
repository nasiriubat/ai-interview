import type {
  Capabilities,
  ChatEvent,
  ChatRequest,
  ProviderConfig,
  Route,
  SpeechInput,
  SttStreamEvent,
  SttStreamInput,
  SttStreamSession,
  Transcript,
  TranscriptionInput,
  Usage,
} from "@aidp/shared";
import { emptyUsage } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ModelCaller, type ModelCallerDeps } from "../src/callModel.js";
import { BudgetGuard, StaticBudgetLimits } from "../src/cost/budget.js";
import { InMemoryLedger } from "../src/cost/ledger.js";
import { costCents, PriceTable, type ModelPrice } from "../src/cost/pricing.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { Provider } from "../src/providers/types.js";

const cfg: ProviderConfig = {
  id: "p1",
  companyId: null,
  kind: "openai",
  name: "p1",
  apiKey: "k",
  headers: {},
  enabled: true,
};

const caps: Capabilities = {
  caching: false,
  structuredOutput: true,
  effort: false,
  batch: false,
  vision: false,
  transcription: true,
  speech: true,
  streamingTranscription: true,
};

/** A stream whose events the test pushes by hand, so it decides when an utterance ends. */
class ManualStream implements SttStreamSession {
  pushed = 0;
  private queue: SttStreamEvent[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  push(pcm: Uint8Array): void {
    this.pushed += pcm.byteLength;
  }
  emit(ev: SttStreamEvent): void {
    this.queue.push(ev);
    this.wake?.();
  }
  close(): void {
    this.done = true;
    this.wake?.();
  }
  events: AsyncIterable<SttStreamEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SttStreamEvent>> => {
        for (;;) {
          const ev = this.queue.shift();
          if (ev) return { value: ev, done: false };
          if (this.done) return { value: undefined, done: true };
          await new Promise<void>((r) => {
            this.wake = r;
          });
        }
      },
    }),
  };
}

class AudioProvider implements Provider {
  readonly kind = "openai" as const;
  readonly capabilities = caps;
  stream = new ManualStream();
  /** Runs before the first text event: how a test makes the provider take time. */
  beforeFirstText: (() => void) | undefined;
  constructor(
    readonly id: string,
    private readonly duration: number | undefined,
  ) {}
  async listModels() {
    return [];
  }
  async *chat(_m: string, _r: ChatRequest): AsyncIterable<ChatEvent> {
    this.beforeFirstText?.();
    yield { type: "text", text: "a" };
    yield { type: "text", text: "b" };
    // Ends without a `done`: the consumer will have walked away before this matters.
  }
  async complete<T>(_m: string, _r: ChatRequest, schema: z.ZodType<T>) {
    return { value: schema.parse({}), usage: emptyUsage() };
  }
  async transcribe(_model: string, _input: TranscriptionInput) {
    const transcript: Transcript = {
      text: "hello",
      ...(this.duration !== undefined ? { durationSeconds: this.duration } : {}),
    };
    return { transcript, usage: emptyUsage() };
  }
  async speak(_m: string, _input: SpeechInput) {
    return {
      mime: "audio/mpeg",
      audio: (async function* () {
        yield new Uint8Array([1]);
      })(),
    };
  }
  async transcribeStream(_m: string, _i: SttStreamInput) {
    return this.stream;
  }
}

const route = (purpose: Route["purpose"], model: string): Route => ({
  companyId: null,
  purpose,
  providerId: "p1",
  model,
  maxOutputTokens: 100,
  batchAllowed: false,
});

function setup(duration: number | undefined, prices: Partial<ModelPrice>[] = []) {
  const provider = new AudioProvider("p1", duration);
  const registry = new ProviderRegistry();
  (registry as unknown as { cache: Map<string, unknown> }).cache.set("p1", { config: cfg, provider });
  const ledger = new InMemoryLedger();
  const table = new PriceTable();
  for (const p of prices)
    table.set({
      providerId: "p1",
      model: "m",
      inputPerMtok: 0,
      cachedInputPerMtok: 0,
      outputPerMtok: 0,
      source: "admin",
      ...p,
    });
  const clock = { t: 1_000_000 };
  const deps: ModelCallerDeps = {
    routes: { resolve: async (_c, purpose) => route(purpose, "m") },
    providerConfigs: { get: async () => cfg },
    registry,
    prices: table,
    ledger,
    budget: new BudgetGuard(new StaticBudgetLimits([]), ledger),
    now: () => new Date(clock.t),
  };
  return { caller: new ModelCaller(deps), ledger, provider, clock };
}

const ctx = { companyId: "c1", sessionId: "s1" };

describe("costCents with audio and speech (D-220)", () => {
  const price: ModelPrice = {
    providerId: "p",
    model: "m",
    inputPerMtok: 0,
    cachedInputPerMtok: 0,
    outputPerMtok: 0,
    audioPerMinute: 0.006,
    ttsPerMChars: 15,
    source: "admin",
  };
  it("prices audio per minute", () => {
    // 90 s = 1.5 min at $0.006/min = $0.009 = 0.9 cents
    expect(costCents(price, { ...emptyUsage(), audioSeconds: 90 })).toBeCloseTo(0.9, 9);
  });
  it("prices speech per million characters", () => {
    // 2 000 chars at $15/M = $0.03 = 3 cents
    expect(costCents(price, { ...emptyUsage(), ttsCharacters: 2000 })).toBeCloseTo(3, 9);
  });
  it("adds to token cost and ignores audio when the model has no audio price", () => {
    const tokens: Usage = { ...emptyUsage(), inputTokens: 1_000_000, audioSeconds: 600 };
    expect(costCents({ ...price, inputPerMtok: 2 }, tokens)).toBeCloseTo(200 + 6, 9);
    const { audioPerMinute: _a, ttsPerMChars: _t, ...tokenOnly } = price;
    expect(costCents(tokenOnly, { ...emptyUsage(), audioSeconds: 600 })).toBe(0);
  });
});

describe("transcribe books audio seconds", () => {
  it("uses the provider's own measurement and prices it", async () => {
    const { caller, ledger } = setup(45, [{ audioPerMinute: 0.006 }]);
    await caller.transcribe(ctx, { data: new Uint8Array(4), mime: "audio/webm", filename: "a.webm" });
    const [row] = ledger.entries;
    expect(row?.usage.audioSeconds).toBe(45);
    expect(row?.costCents).toBeCloseTo((45 / 60) * 0.006 * 100, 9);
    expect(row?.estimated).toBeUndefined();
  });

  it("falls back to the duration the caller knew when the provider reports none", async () => {
    const { caller, ledger } = setup(undefined, [{ audioPerMinute: 0.006 }]);
    await caller.transcribe(ctx, {
      data: new Uint8Array(4),
      mime: "audio/webm",
      filename: "a.webm",
      durationSeconds: 30,
    });
    expect(ledger.entries[0]?.usage.audioSeconds).toBe(30);
  });
});

describe("speak books characters", () => {
  it("records the characters and prices them per million", async () => {
    const { caller, ledger } = setup(undefined, [{ ttsPerMChars: 15 }]);
    await caller.speak(ctx, { text: "x".repeat(1000) });
    const [row] = ledger.entries;
    expect(row?.usage.ttsCharacters).toBe(1000);
    expect(row?.usage.outputTokens).toBe(0);
    expect(row?.costCents).toBeCloseTo((1000 / 1e6) * 15 * 100, 9);
  });

  it("keeps the four-characters-a-token approximation for a model priced by tokens", async () => {
    const { caller, ledger } = setup(undefined, [{ outputPerMtok: 10 }]);
    await caller.speak(ctx, { text: "x".repeat(400) });
    expect(ledger.entries[0]?.usage.outputTokens).toBe(100);
    expect(ledger.entries[0]?.usage.ttsCharacters).toBe(400);
  });
});

describe("transcribeStream books audio seconds", () => {
  const BYTES_PER_SECOND = 48_000;

  it("books the provider's duration for a finished utterance", async () => {
    const { caller, ledger, provider } = setup(undefined, [{ audioPerMinute: 0.006 }]);
    const session = await caller.transcribeStream(ctx, {});
    expect(session).toBeDefined();
    provider.stream.emit({ type: "final", itemId: "i", text: "hi", durationSeconds: 4 });
    provider.stream.close();
    for await (const _ of session!.events) _;
    const [row] = ledger.entries;
    expect(row?.usage.audioSeconds).toBe(4);
    expect(row?.estimated).toBeUndefined();
  });

  it("counts the pushed PCM when the provider does not say, and marks it estimated", async () => {
    const { caller, ledger, provider } = setup(undefined, [{ audioPerMinute: 0.006 }]);
    const session = await caller.transcribeStream(ctx, {});
    session!.push(new Uint8Array(BYTES_PER_SECOND * 3));
    provider.stream.emit({ type: "final", itemId: "i", text: "hi" });
    provider.stream.close();
    for await (const _ of session!.events) _;
    expect(ledger.entries[0]?.usage.audioSeconds).toBeCloseTo(3, 9);
    expect(ledger.entries[0]?.estimated).toBe(true);
  });

  it("books audio that never reached a final when the call ends mid-utterance", async () => {
    const { caller, ledger, provider } = setup(undefined, [{ audioPerMinute: 0.006 }]);
    const session = await caller.transcribeStream(ctx, {});
    session!.push(new Uint8Array(BYTES_PER_SECOND * 2));
    provider.stream.close();
    for await (const _ of session!.events) _;
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ status: "aborted", estimated: true });
    expect(ledger.entries[0]?.usage.audioSeconds).toBeCloseTo(2, 9);
  });

  it("books the partial seconds of a session that dies, as an estimate", async () => {
    const { caller, ledger, provider } = setup(undefined, [{ audioPerMinute: 0.006 }]);
    const session = await caller.transcribeStream(ctx, {});
    session!.push(new Uint8Array(BYTES_PER_SECOND));
    provider.stream.emit({ type: "error", message: "socket", fatal: true });
    provider.stream.close();
    for await (const _ of session!.events) _;
    expect(ledger.entries[0]).toMatchObject({ status: "error", estimated: true });
    expect(ledger.entries[0]?.usage.audioSeconds).toBeCloseTo(1, 9);
  });
});

describe("chat books first token latency and abandoned streams", () => {
  it("records time to the first text event", async () => {
    const { caller, ledger, clock, provider } = setup(undefined);
    provider.beforeFirstText = () => {
      clock.t += 350;
    };
    const gen = caller
      .chat("interview_turn", ctx, { messages: [{ role: "user", content: "hi" }] })
      [Symbol.asyncIterator]();
    await gen.next(); // first text
    clock.t += 500;
    await gen.return?.(undefined); // consumer walks away after the first words
    const [row] = ledger.entries;
    expect(row?.firstTokenMs).toBe(350);
    expect(row).toMatchObject({ status: "aborted", estimated: true });
  });
});

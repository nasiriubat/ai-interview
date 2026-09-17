import type { Capabilities, ChatEvent, ChatRequest, ProviderConfig, Route, SpeechInput } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ModelCaller } from "../src/callModel.js";
import { BudgetExceededError, BudgetGuard, StaticBudgetLimits } from "../src/cost/budget.js";
import { InMemoryLedger } from "../src/cost/ledger.js";
import { PriceTable } from "../src/cost/pricing.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderError, type Provider } from "../src/providers/types.js";

const cfg: ProviderConfig = {
  id: "p1",
  companyId: null,
  kind: "openai",
  name: "p1",
  baseUrl: "https://example.invalid",
  apiKey: "k",
  headers: {},
  enabled: true,
};

class SpeakingProvider implements Provider {
  readonly kind = "openai" as const;
  readonly capabilities: Capabilities = {
    caching: false,
    structuredOutput: true,
    effort: false,
    batch: false,
    vision: false,
    transcription: true,
    speech: true,
  };
  lastInput: SpeechInput | undefined;
  aborted = false;
  constructor(
    readonly id: string,
    private readonly behaviour: "ok" | "throw" = "ok",
  ) {}
  async listModels() {
    return [];
  }
  async *chat(): AsyncIterable<ChatEvent> {
    // Unused here.
  }
  async complete<T>(_m: string, _r: ChatRequest, schema: z.ZodType<T>) {
    return {
      value: schema.parse({}),
      usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
    };
  }
  async speak(_model: string, input: SpeechInput, signal?: AbortSignal) {
    this.lastInput = input;
    if (this.behaviour === "throw") throw new ProviderError("speech host down", "server", true);
    // Records that it noticed the abort, so a test can assert the provider stopped producing
    // rather than merely that the consumer stopped reading.
    const markAborted = (): void => {
      this.aborted = true;
    };
    return {
      mime: "audio/ogg",
      audio: (async function* () {
        yield new Uint8Array([1, 2, 3]);
        if (signal?.aborted) {
          markAborted();
          return;
        }
        yield new Uint8Array([4, 5, 6]);
      })(),
    };
  }
}

/** A provider that can do everything except speak, which is the common case. */
class MuteProvider extends SpeakingProvider {
  override readonly capabilities: Capabilities = {
    caching: false,
    structuredOutput: true,
    effort: false,
    batch: false,
    vision: false,
    transcription: true,
    speech: false,
  };
  override speak = undefined as unknown as SpeakingProvider["speak"];
}

function setup(options: { provider?: Provider; ttsRoute?: boolean; limitCents?: number } = {}) {
  const provider = options.provider ?? new SpeakingProvider("p1");
  const registry = new ProviderRegistry();
  (registry as unknown as { cache: Map<string, unknown> }).cache.set("p1", { config: cfg, provider });
  const ledger = new InMemoryLedger();
  const route: Route = {
    companyId: null,
    purpose: "tts",
    providerId: "p1",
    model: "tts-1",
    effort: "low",
    maxOutputTokens: 0,
    batchAllowed: false,
  };
  const caller = new ModelCaller({
    routes: {
      resolve: async (_c, purpose) => (purpose === "tts" && options.ttsRoute !== false ? route : undefined),
    },
    providerConfigs: { get: async () => cfg },
    registry,
    prices: new PriceTable([
      {
        providerId: "p1",
        model: "tts-1",
        inputPerMtok: 0,
        cachedInputPerMtok: 0,
        outputPerMtok: 15,
        source: "admin",
      },
    ]),
    ledger,
    budget: new BudgetGuard(
      new StaticBudgetLimits(
        options.limitCents === undefined
          ? []
          : [{ scope: "tenant", scopeId: "c1", limitCents: options.limitCents, period: "month" }],
      ),
      ledger,
    ),
  });
  return { caller, provider: provider as SpeakingProvider, ledger };
}

const ctx = { companyId: "c1", sessionId: "s1" };

describe("ModelCaller.speak", () => {
  it("streams the audio rather than handing back a finished buffer", async () => {
    const { caller } = setup();

    const out = await caller.speak(ctx, { text: "How long does that take?" });

    expect(out?.mime).toBe("audio/ogg");
    const chunks: Uint8Array[] = [];
    for await (const chunk of out?.audio ?? []) chunks.push(chunk);
    // Two chunks, not one: the first can reach the participant's speakers while the provider is
    // still synthesizing, which is the whole latency argument for the feature.
    expect(chunks).toHaveLength(2);
  });

  it("passes the voice and rate the tenant configured", async () => {
    const { caller, provider } = setup();

    await caller.speak(ctx, { text: "Hello", voice: "shimmer", speed: 1.2, format: "opus" });

    expect(provider.lastInput).toMatchObject({ voice: "shimmer", speed: 1.2, format: "opus" });
  });

  it("answers undefined when the tenant has no speech route, so callers can degrade", async () => {
    const { caller, ledger } = setup({ ttsRoute: false });

    expect(await caller.speak(ctx, { text: "Hello" })).toBeUndefined();
    // Nothing attempted means nothing billed.
    expect(ledger.entries).toHaveLength(0);
  });

  it("refuses a provider that cannot speak, rather than failing silently", async () => {
    const { caller } = setup({ provider: new MuteProvider("p1") });

    await expect(caller.speak(ctx, { text: "Hello" })).rejects.toThrow(/cannot speak/);
  });

  it("bills the call as soon as the provider accepts it, not when the audio ends", async () => {
    // Barge-in abandons most streams part-way. Waiting for the stream to finish would under-count
    // exactly the calls that get interrupted, which in a live interview is most of them.
    const { caller, ledger } = setup();

    await caller.speak(ctx, { text: "a".repeat(400) });

    const entry = ledger.entries.at(-1);
    expect(entry?.purpose).toBe("tts");
    expect(entry?.status).toBe("ok");
    expect(entry?.usage.outputTokens).toBe(100); // roughly four characters to a token
    expect(entry?.costCents).toBeGreaterThan(0);
  });

  it("records a failed call too", async () => {
    const { caller, ledger } = setup({ provider: new SpeakingProvider("p1", "throw") });

    await expect(caller.speak(ctx, { text: "Hello" })).rejects.toThrow(/speech host down/);

    expect(ledger.entries.at(-1)).toMatchObject({ purpose: "tts", status: "error" });
  });

  it("stops before spending when the budget is gone", async () => {
    const { caller, ledger } = setup({ limitCents: 0 });

    await expect(caller.speak(ctx, { text: "Hello" })).rejects.toThrow(BudgetExceededError);

    expect(ledger.entries.at(-1)).toMatchObject({ status: "budget_exceeded" });
  });

  it("stops producing audio once the call is aborted", async () => {
    const { caller, provider } = setup();
    const controller = new AbortController();

    const out = await caller.speak(ctx, { text: "Hello" }, controller.signal);
    const chunks: Uint8Array[] = [];
    for await (const chunk of out?.audio ?? []) {
      chunks.push(chunk);
      controller.abort();
    }

    expect(chunks).toHaveLength(1);
    expect(provider.aborted).toBe(true);
  });
});

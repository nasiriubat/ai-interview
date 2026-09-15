import type { Capabilities, ChatEvent, ChatRequest, ProviderConfig, Route } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ModelCaller } from "../../src/callModel.js";
import { BudgetGuard, StaticBudgetLimits } from "../../src/cost/budget.js";
import { InMemoryLedger } from "../../src/cost/ledger.js";
import { PriceTable } from "../../src/cost/pricing.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { clip, ingestAttachment, MAX_CHUNKS } from "../../src/ingest/pipeline.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type { Provider } from "../../src/providers/types.js";

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

class FakeProvider implements Provider {
  readonly kind = "openai" as const;
  readonly capabilities: Capabilities = {
    caching: false,
    structuredOutput: true,
    effort: false,
    batch: false,
    vision: true,
    transcription: false,
  };
  readonly calls: ChatRequest[] = [];
  embedCalls = 0;
  constructor(
    readonly id: string,
    private readonly reply: (req: ChatRequest) => string,
    private readonly embedder?: (texts: string[]) => number[][] | Error,
  ) {}
  async listModels() {
    return [];
  }
  async *chat(_model: string, req: ChatRequest): AsyncIterable<ChatEvent> {
    this.calls.push(req);
    yield { type: "text", text: this.reply(req) };
    yield {
      type: "done",
      usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
      stopReason: "end_turn",
      model: "m",
    };
  }
  async complete<T>(_model: string, _req: ChatRequest, schema: z.ZodType<T>) {
    return {
      value: schema.parse({}),
      usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
    };
  }
  async embed(_model: string, texts: string[]) {
    this.embedCalls++;
    const out = this.embedder?.(texts);
    if (out instanceof Error) throw out;
    return {
      vectors: out ?? texts.map((_, i) => [i, 1, 0]),
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    };
  }
}

function setup(
  options: {
    reply?: (req: ChatRequest) => string;
    embedder?: (texts: string[]) => number[][] | Error;
    embeddingRoute?: boolean;
  } = {},
) {
  const provider = new FakeProvider(
    "p1",
    options.reply ?? (() => "Referrals arrive by fax and are retyped into Lifecare."),
    options.embedder,
  );
  const registry = new ProviderRegistry();
  (registry as unknown as { cache: Map<string, unknown> }).cache.set("p1", { config: cfg, provider });
  const ledger = new InMemoryLedger();
  const route = (purpose: string): Route => ({
    companyId: null,
    purpose: purpose as Route["purpose"],
    providerId: "p1",
    model: "m",
    effort: "low",
    maxOutputTokens: 400,
    batchAllowed: false,
  });
  const warned: { message: string }[] = [];
  const caller = new ModelCaller({
    routes: {
      resolve: async (_c, purpose) =>
        purpose === "embedding" && options.embeddingRoute === false ? undefined : route(purpose),
    },
    providerConfigs: { get: async () => cfg },
    registry,
    prices: new PriceTable([]),
    ledger,
    budget: new BudgetGuard(new StaticBudgetLimits([]), ledger),
  });
  const deps = {
    caller,
    prompts: new ShippedPromptSource(),
    logger: { warn: (message: string) => warned.push({ message }) },
  };
  return { deps, provider, ledger, warned };
}

const ctx = { companyId: "c1", sessionId: "s1" };

const longDoc = Array.from(
  { length: 20 },
  (_, i) => `Step ${i}. The referral is retyped into the ward spreadsheet by hand each morning.`,
).join("\n\n");

describe("ingestAttachment: documents", () => {
  it("extracts, summarizes, chunks and embeds in one pass", async () => {
    const { deps, provider } = setup();

    const out = await ingestAttachment(deps, ctx, {
      bytes: Buffer.from(longDoc),
      mime: "text/plain",
      filename: "procedure.txt",
    });

    expect(out.empty).toBe(false);
    expect(out.text).toContain("retyped into the ward spreadsheet");
    expect(out.summary).toContain("Referrals arrive by fax");
    expect(out.chunks.length).toBeGreaterThan(1);
    expect(out.vectors).toHaveLength(out.chunks.length);
    expect(provider.embedCalls).toBe(1);
  });

  it("gives the summarizer the file name and the text, under the shipped prompt", async () => {
    const { deps, provider } = setup();

    await ingestAttachment(deps, ctx, {
      bytes: Buffer.from(longDoc),
      mime: "text/plain",
      filename: "ward-procedure.txt",
    });

    const [call] = provider.calls;
    expect(call?.system).toContain("how their work is done");
    expect(String(call?.messages[0]?.content)).toContain("ward-procedure.txt");
    expect(String(call?.messages[0]?.content)).toContain("retyped into the ward spreadsheet");
  });

  it("asks for the summary in the interview's language when one is given", async () => {
    const { deps, provider } = setup();

    await ingestAttachment(deps, ctx, {
      bytes: Buffer.from(longDoc),
      mime: "text/plain",
      filename: "a.txt",
      language: "fi",
    });

    expect(String(provider.calls[0]?.messages[0]?.content)).toContain("fi");
  });

  it("records what it spent, per purpose", async () => {
    const { deps, ledger } = setup();

    await ingestAttachment(deps, ctx, {
      bytes: Buffer.from(longDoc),
      mime: "text/plain",
      filename: "a.txt",
    });

    const purposes = ledger.entries.map((e) => e.purpose);
    expect(purposes).toContain("file_ingest");
    expect(purposes).toContain("embedding");
  });

  it("stops at the chunk cap rather than ingesting a book", async () => {
    const huge = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(60)}`).join("\n\n");
    const { deps } = setup();

    const out = await ingestAttachment(deps, ctx, {
      bytes: Buffer.from(huge),
      mime: "text/plain",
      filename: "book.txt",
    });

    expect(out.chunks.length).toBe(MAX_CHUNKS);
  });
});

describe("ingestAttachment: a file it could not read", () => {
  it("reports empty without calling a model, because there is nothing to summarize", async () => {
    const { deps, provider } = setup();

    const out = await ingestAttachment(deps, ctx, {
      bytes: Buffer.from("  \n "),
      mime: "text/plain",
      filename: "scan.txt",
    });

    expect(out.empty).toBe(true);
    expect(out.summary).toBe("");
    expect(out.chunks).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("ingestAttachment: images", () => {
  it("describes an image through the vision route and treats the description as its text", async () => {
    const { deps, provider } = setup({
      reply: (req) =>
        Array.isArray(req.messages[0]?.content)
          ? "Lifecare referral screen. Fields: Name, Personal ID, Ward."
          : "Summary of the screenshot.",
    });

    const out = await ingestAttachment(deps, ctx, {
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mime: "image/png",
      filename: "screen.png",
    });

    expect(out.text).toContain("Lifecare referral screen");
    expect(out.summary).toBe("Summary of the screenshot.");
    const parts = provider.calls[0]?.messages[0]?.content;
    expect(Array.isArray(parts)).toBe(true);
    expect(Array.isArray(parts) ? parts[1] : undefined).toMatchObject({
      type: "image",
      mime: "image/png",
    });
  });

  it("treats a model that describes nothing as an unreadable image", async () => {
    const { deps } = setup({ reply: () => "   " });

    const out = await ingestAttachment(deps, ctx, {
      bytes: Buffer.from([0x89]),
      mime: "image/png",
      filename: "blank.png",
    });

    expect(out.empty).toBe(true);
  });
});

describe("ingestAttachment: embeddings are optional", () => {
  it("still ingests when no embedding route is configured, which is the OpenRouter case", async () => {
    const { deps, provider } = setup({ embeddingRoute: false });

    const out = await ingestAttachment(deps, ctx, {
      bytes: Buffer.from(longDoc),
      mime: "text/plain",
      filename: "a.txt",
    });

    expect(out.chunks.length).toBeGreaterThan(0);
    expect(out.vectors).toBeUndefined();
    expect(provider.embedCalls).toBe(0);
  });

  it("survives an embedding provider that fails, and says so once", async () => {
    const { deps, warned } = setup({ embedder: () => new Error("502 from the embedding host") });

    const out = await ingestAttachment(deps, ctx, {
      bytes: Buffer.from(longDoc),
      mime: "text/plain",
      filename: "a.txt",
    });

    // A file retrievable by keyword beats a file that failed to ingest.
    expect(out.chunks.length).toBeGreaterThan(0);
    expect(out.vectors).toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toMatch(/lexically/);
  });
});

describe("clip", () => {
  it("leaves short text alone", () => {
    expect(clip("short", 100)).toBe("short");
  });

  it("keeps the end as well as the beginning, and marks the join", () => {
    // The end of a procedure is where the exceptions and escalation paths live; truncating from
    // the front throws away the part most worth asking about.
    const text = `START${"x".repeat(500)}END`;

    const out = clip(text, 100);

    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("END")).toBe(true);
    expect(out).toContain("[...omitted...]");
  });
});

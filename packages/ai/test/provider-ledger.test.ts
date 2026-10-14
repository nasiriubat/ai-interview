import type { Capabilities, ChatEvent, ChatRequest, ProviderConfig, Route, Usage } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelCaller } from "../src/callModel.js";
import { BudgetGuard, StaticBudgetLimits } from "../src/cost/budget.js";
import { InMemoryLedger } from "../src/cost/ledger.js";
import { PriceTable } from "../src/cost/pricing.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderError, type Provider } from "../src/providers/types.js";

const Ok = z.object({ ok: z.boolean() });
const req = (extra: object = {}) => ({
  messages: [{ role: "user" as const, content: "x" }],
  maxOutputTokens: 100,
  cachePrefix: false,
  ...extra,
});

describe("OpenAICompatibleProvider: capability memory and attempt reports (live run bugs 7 and 8)", () => {
  it("learns that a route refuses strict json_schema and does not ask again", async () => {
    const formats: string[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { response_format: { type: string } };
      formats.push(body.response_format.type);
      if (body.response_format.type === "json_schema") return new Response("{}", { status: 400 });
      return Response.json({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      });
    };
    const p = new OpenAICompatibleProvider({
      id: "lt",
      kind: "litellm",
      apiKey: "k",
      baseUrl: "http://gateway.test/v1",
      fetch: fetchMock,
    });
    await p.complete("some-model", req(), Ok);
    await p.complete("some-model", req(), Ok);
    await p.complete("some-model", req(), Ok);
    // One wasted round trip in total, not one per call.
    expect(formats).toEqual(["json_schema", "json_object", "json_object", "json_object"]);
  });

  it("never sends strict json_schema to an anthropic/ model behind a gateway", async () => {
    const formats: string[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      formats.push(
        (JSON.parse(String(init?.body)) as { response_format: { type: string } }).response_format.type,
      );
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    };
    const p = new OpenAICompatibleProvider({ id: "or", kind: "openrouter", apiKey: "k", fetch: fetchMock });
    await p.complete("anthropic/claude-haiku-5.5", req(), Ok);
    expect(formats).toEqual(["json_object"]);
  });

  it("reports every attempt with the usage the provider billed, including the rejected one", async () => {
    let n = 0;
    const fetchMock: typeof fetch = async () => {
      n++;
      if (n === 1) return new Response("{}", { status: 422 });
      return Response.json({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 7 },
      });
    };
    const p = new OpenAICompatibleProvider({ id: "oa", kind: "openai", apiKey: "k", fetch: fetchMock });
    const reports: { ok: boolean; note?: string; out: number }[] = [];
    await p.complete(
      "gpt-x",
      req({
        onAttempt: (a: { ok: boolean; note?: string; usage: { outputTokens: number } }) =>
          reports.push({ ok: a.ok, ...(a.note ? { note: a.note } : {}), out: a.usage.outputTokens }),
      }),
      Ok,
    );
    expect(reports).toEqual([
      { ok: false, note: "rejected", out: 0 },
      { ok: true, out: 7 },
    ]);
  });

  it("reports a truncated answer's tokens before throwing", async () => {
    const fetchMock: typeof fetch = async () =>
      Response.json({
        choices: [{ message: { content: '{"ok' }, finish_reason: "length" }],
        usage: { prompt_tokens: 30, completion_tokens: 100 },
      });
    const p = new OpenAICompatibleProvider({ id: "oa", kind: "openai", apiKey: "k", fetch: fetchMock });
    const outs: number[] = [];
    await expect(
      p.complete(
        "gpt-x",
        req({ onAttempt: (a: { usage: { outputTokens: number } }) => outs.push(a.usage.outputTokens) }),
        Ok,
      ),
    ).rejects.toThrow(/cut off/);
    expect(outs).toEqual([100, 100]); // strict attempt, then the JSON-mode attempt
  });

  it("asks an OpenRouter route to skip hidden reasoning, and stops asking once it is refused", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.reasoning) return new Response("{}", { status: 400 });
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    };
    const p = new OpenAICompatibleProvider({ id: "or", kind: "openrouter", apiKey: "k", fetch: fetchMock });
    await p.complete("vendor/model", req({ reasoning: "off" }), Ok);
    await p.complete("vendor/model", req({ reasoning: "off" }), Ok);
    expect(bodies[0]?.reasoning).toEqual({ effort: "none" });
    expect(bodies.slice(1).every((b) => b.reasoning === undefined)).toBe(true);
    expect(bodies).toHaveLength(3);
  });

  it("retries without the reasoning control when the route answers 404 for it (live run: two jobs failed)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      // OpenRouter with require_parameters: "No endpoints found that support reasoning".
      if (body.reasoning) return new Response("{}", { status: 404 });
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    };
    const p = new OpenAICompatibleProvider({ id: "or", kind: "openrouter", apiKey: "k", fetch: fetchMock });
    const reports: string[] = [];
    const res = await p.complete(
      "vendor/model",
      req({ reasoning: "off", onAttempt: (a: { note?: string }) => reports.push(a.note ?? "ok") }),
      Ok,
    );
    expect(res.value).toEqual({ ok: true });
    expect(bodies.at(-1)).not.toHaveProperty("reasoning");
    expect(reports[0]).toBe("rejected");
  });

  it("blames the schema, not the reasoning control, when the same 400 comes back without it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format: { type: string };
        reasoning?: unknown;
      };
      bodies.push(body);
      if (body.response_format.type === "json_schema") return new Response("{}", { status: 400 });
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    };
    const p = new OpenAICompatibleProvider({ id: "or", kind: "openrouter", apiKey: "k", fetch: fetchMock });
    await p.complete("vendor/model", req({ reasoning: "off" }), Ok);
    await p.complete("vendor/model", req({ reasoning: "off" }), Ok);
    const jsonMode = bodies.filter((b) => (b.response_format as { type: string }).type === "json_object");
    // Reasoning stayed on for the model: both JSON-mode calls carried it.
    expect(jsonMode.every((b) => b.reasoning !== undefined)).toBe(true);
    // And the strict schema was asked about exactly twice (with and without the control), once.
    expect(bodies.filter((b) => (b.response_format as { type: string }).type === "json_schema")).toHaveLength(
      2,
    );
  });

  it("does not send the reasoning control to a plain OpenAI-compatible server", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    };
    const p = new OpenAICompatibleProvider({ id: "oa", kind: "openai", apiKey: "k", fetch: fetchMock });
    await p.complete("gpt-x", req({ reasoning: "off" }), Ok);
    expect(bodies[0]).not.toHaveProperty("reasoning");
  });
});

const cfg: ProviderConfig = {
  id: "p1",
  companyId: null,
  kind: "openai",
  name: "fake",
  apiKey: "k",
  headers: {},
  enabled: true,
};

class ScriptedProvider implements Provider {
  readonly kind = "openai" as const;
  readonly id = "p1";
  readonly capabilities: Capabilities = {
    caching: false,
    structuredOutput: true,
    effort: false,
    batch: false,
    vision: false,
    transcription: false,
    speech: false,
    streamingTranscription: false,
  };
  lastReq?: ChatRequest;
  completeImpl: (req: ChatRequest) => Promise<{ value: unknown; usage: Usage }> = async () => {
    throw new Error("unscripted");
  };
  async listModels() {
    return [];
  }
  // eslint-disable-next-line require-yield
  async *chat(_model: string, req: ChatRequest): AsyncIterable<ChatEvent> {
    this.lastReq = req;
    throw new ProviderError("Provider returned 500", "server", true);
  }
  async complete<T>(_model: string, req: ChatRequest, schema: z.ZodType<T>) {
    this.lastReq = req;
    const out = await this.completeImpl(req);
    return { value: schema.parse(out.value), usage: out.usage };
  }
}

function setup(effort?: Route["effort"]) {
  const provider = new ScriptedProvider();
  const registry = new (class extends ProviderRegistry {
    override get(): Provider {
      return provider;
    }
  })();
  const ledger = new InMemoryLedger();
  const prices = new PriceTable([
    {
      providerId: "p1",
      model: "m",
      inputPerMtok: 1,
      cachedInputPerMtok: 0.1,
      outputPerMtok: 10,
      source: "admin",
    },
  ]);
  const route: Route = {
    companyId: null,
    purpose: "extraction",
    providerId: "p1",
    model: "m",
    ...(effort ? { effort } : {}),
    maxOutputTokens: 777,
    batchAllowed: false,
  };
  const caller = new ModelCaller({
    routes: { resolve: async () => route },
    providerConfigs: { get: async () => cfg },
    registry,
    prices,
    ledger,
    budget: new BudgetGuard(
      new StaticBudgetLimits([{ scope: "tenant", scopeId: "c1", limitCents: 100_000, period: "month" }]),
      ledger,
    ),
  });
  return { caller, provider, ledger };
}

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens,
});

describe("ModelCaller books failed and rejected attempts (live run bug 7)", () => {
  it("writes one row per reported attempt, with the tokens each one cost", async () => {
    const { caller, provider, ledger } = setup();
    provider.completeImpl = async (r) => {
      r.onAttempt?.({ usage: usage(0, 0), ok: false, note: "rejected", latencyMs: 5 });
      r.onAttempt?.({ usage: usage(2000, 900), ok: false, note: "truncated", latencyMs: 20 });
      r.onAttempt?.({ usage: usage(2000, 50), ok: true, latencyMs: 8 });
      return { value: { ok: true }, usage: usage(2000, 50) };
    };
    await caller.complete(
      "extraction",
      { companyId: "c1" },
      { messages: [{ role: "user", content: "x" }] },
      Ok,
    );
    expect(ledger.entries.map((e) => e.status)).toEqual(["error", "error", "ok"]);
    expect(ledger.entries.map((e) => e.usage.outputTokens)).toEqual([0, 900, 50]);
    // 2000 in at $1/M + 900 out at $10/M = 0.2 + 0.9 cents
    expect(ledger.entries[1]!.costCents).toBeCloseTo(1.1, 9);
  });

  it("books the reported tokens of a call that then failed validation", async () => {
    const { caller, provider, ledger } = setup();
    provider.completeImpl = async (r) => {
      r.onAttempt?.({ usage: usage(1000, 700), ok: false, note: "invalid", latencyMs: 9 });
      throw new ProviderError("Structured output failed validation", "parse", true);
    };
    await expect(
      caller.complete("extraction", { companyId: "c1" }, { messages: [{ role: "user", content: "x" }] }, Ok),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ status: "error" });
    expect(ledger.entries[0]!.usage.outputTokens).toBe(700);
    expect(ledger.entries[0]!.costCents).toBeGreaterThan(0);
  });

  it("estimates an unreported parse failure at the prompt plus the whole output allowance", async () => {
    const { caller, provider, ledger } = setup();
    provider.completeImpl = async () => {
      throw new ProviderError("Structured output did not parse", "parse", true);
    };
    await expect(
      caller.complete(
        "extraction",
        { companyId: "c1" },
        { messages: [{ role: "user", content: "x".repeat(4000) }] },
        Ok,
      ),
    ).rejects.toThrow();
    expect(ledger.entries[0]!.usage.inputTokens).toBeGreaterThan(500);
    expect(ledger.entries[0]!.usage.outputTokens).toBe(777); // the route's allowance
    expect(ledger.entries[0]!.costCents).toBeGreaterThan(0);
  });

  it("books a provider that rejected the request outright at zero", async () => {
    const { caller, provider, ledger } = setup();
    provider.completeImpl = async () => {
      throw new ProviderError("Provider returned 401", "auth", false);
    };
    await expect(
      caller.complete("extraction", { companyId: "c1" }, { messages: [{ role: "user", content: "x" }] }, Ok),
    ).rejects.toThrow();
    expect(ledger.entries[0]).toMatchObject({ status: "error", costCents: 0 });
  });

  it("books a failed stream at the prompt it was sent", async () => {
    const { caller, ledger } = setup();
    await expect(async () => {
      for await (const _ of caller.chat(
        "extraction",
        { companyId: "c1" },
        { messages: [{ role: "user", content: "y".repeat(2000) }] },
      ));
    }).rejects.toThrow();
    expect(ledger.entries[0]).toMatchObject({ status: "error" });
    expect(ledger.entries[0]!.usage.inputTokens).toBeGreaterThan(300);
  });
});

describe("ModelCaller output allowance and reasoning (live run bug 8)", () => {
  it("uses the route's maxOutputTokens when the caller names none, and keeps a caller's own", async () => {
    const { caller, provider } = setup();
    provider.completeImpl = async () => ({ value: { ok: true }, usage: usage(1, 1) });
    await caller.complete(
      "extraction",
      { companyId: "c1" },
      { messages: [{ role: "user", content: "x" }] },
      Ok,
    );
    expect(provider.lastReq?.maxOutputTokens).toBe(777);
    await caller.complete(
      "extraction",
      { companyId: "c1" },
      { messages: [{ role: "user", content: "x" }], maxOutputTokens: 50 },
      Ok,
    );
    expect(provider.lastReq?.maxOutputTokens).toBe(50);
  });

  it("switches hidden reasoning off unless the route asks for high effort", async () => {
    const low = setup("low");
    low.provider.completeImpl = async () => ({ value: { ok: true }, usage: usage(1, 1) });
    await low.caller.complete(
      "extraction",
      { companyId: "c1" },
      { messages: [{ role: "user", content: "x" }] },
      Ok,
    );
    expect(low.provider.lastReq?.reasoning).toBe("off");

    const none = setup();
    none.provider.completeImpl = async () => ({ value: { ok: true }, usage: usage(1, 1) });
    await none.caller.complete(
      "extraction",
      { companyId: "c1" },
      { messages: [{ role: "user", content: "x" }] },
      Ok,
    );
    expect(none.provider.lastReq?.reasoning).toBe("off");

    const high = setup("high");
    high.provider.completeImpl = async () => ({ value: { ok: true }, usage: usage(1, 1) });
    await high.caller.complete(
      "extraction",
      { companyId: "c1" },
      { messages: [{ role: "user", content: "x" }] },
      Ok,
    );
    expect(high.provider.lastReq?.reasoning).toBeUndefined();
  });
});

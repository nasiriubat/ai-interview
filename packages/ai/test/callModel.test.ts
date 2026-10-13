import type { Capabilities, ChatEvent, ChatRequest, ProviderConfig, Route } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CallAbortedError, ModelCaller, ProbeLimitError } from "../src/callModel.js";
import { BudgetExceededError, BudgetGuard, StaticBudgetLimits } from "../src/cost/budget.js";
import { InMemoryLedger } from "../src/cost/ledger.js";
import { PriceTable } from "../src/cost/pricing.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { Provider } from "../src/providers/types.js";

class FakeProvider implements Provider {
  readonly kind = "openai" as const;
  readonly capabilities: Capabilities = {
    caching: false,
    structuredOutput: true,
    effort: false,
    batch: false,
    vision: false,
    transcription: false,
    speech: false,
  };
  lastReq?: ChatRequest;
  constructor(readonly id: string) {}
  async listModels() {
    return [];
  }
  async *chat(_model: string, req: ChatRequest): AsyncIterable<ChatEvent> {
    this.lastReq = req;
    yield { type: "text", text: "ok" };
    yield {
      type: "done",
      usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 },
      stopReason: "end_turn",
      model: "m",
    };
  }
  async complete<T>(_model: string, _req: ChatRequest, schema: z.ZodType<T>) {
    return {
      value: schema.parse({ ok: true }),
      usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
    };
  }
}

function setup(limitCents: number) {
  const provider = new FakeProvider("p1");
  const registry = new ProviderRegistry();
  (registry as unknown as { cache: Map<string, unknown> }).cache.set("p1", { config: cfg, provider });
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
    purpose: "interview_turn",
    providerId: "p1",
    model: "m",
    effort: "low",
    maxOutputTokens: 200,
    batchAllowed: false,
  };
  const warnings: unknown[] = [];
  const caller = new ModelCaller({
    routes: { resolve: async () => route },
    providerConfigs: { get: async () => cfg },
    registry,
    prices,
    ledger,
    budget: new BudgetGuard(
      new StaticBudgetLimits([{ scope: "tenant", scopeId: "c1", limitCents, period: "month" }]),
      ledger,
    ),
    onBudgetWarning: (_ctx, w) => warnings.push(...w),
  });
  return { caller, ledger, provider, warnings };
}

const cfg: ProviderConfig = {
  id: "p1",
  companyId: null,
  kind: "openai",
  name: "fake",
  apiKey: "k",
  headers: {},
  enabled: true,
};

describe("ModelCaller", () => {
  it("streams, applies the route, and writes a priced ledger row", async () => {
    const { caller, ledger, provider } = setup(10_000);
    const out: string[] = [];
    for await (const ev of caller.chat(
      "interview_turn",
      { companyId: "c1", sessionId: "i1" },
      { messages: [{ role: "user", content: "hi" }], cachePrefix: true },
    )) {
      if (ev.type === "text") out.push(ev.text);
    }
    expect(out).toEqual(["ok"]);
    expect(provider.lastReq).toMatchObject({ maxOutputTokens: 200, cachePrefix: false }); // provider lacks caching and effort
    expect(provider.lastReq?.effort).toBeUndefined();
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      companyId: "c1",
      sessionId: "i1",
      purpose: "interview_turn",
      status: "ok",
    });
    // 1000 input at $1/M + 100 output at $10/M = $0.002 = 0.2 cents
    expect(ledger.entries[0]!.costCents).toBeCloseTo(0.2, 9);
  });

  it("refuses the call and records budget_exceeded when the estimate breaks the budget", async () => {
    const { caller, ledger } = setup(0.01);
    const it = caller.chat(
      "interview_turn",
      { companyId: "c1" },
      { messages: [{ role: "user", content: "hi" }], cachePrefix: false },
    );
    await expect(it[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(ledger.entries[0]).toMatchObject({ status: "budget_exceeded", costCents: 0 });
  });

  it("emits a warning when a call lands past 80 percent of a budget", async () => {
    const { caller, warnings } = setup(0.25);
    await caller.complete(
      "interview_turn",
      { companyId: "c1" },
      { messages: [{ role: "user", content: "hi" }] },
      z.object({ ok: z.boolean() }),
    );
    expect(warnings).toHaveLength(1);
  });
});

describe("ModelCaller cancellation (D-104)", () => {
  const request = (signal: AbortSignal) => ({
    messages: [{ role: "user" as const, content: "hello there" }],
    signal,
  });

  /** A provider that streams one chunk and then waits for the caller's signal, as a long answer does. */
  const blockUntilAborted = (
    provider: { chat: Provider["chat"] },
    sawSignal: { value?: AbortSignal | undefined },
  ) => {
    provider.chat = async function* (_model: string, req: ChatRequest) {
      sawSignal.value = req.signal;
      yield { type: "text" as const, text: "Once upon a time, " };
      await new Promise<void>((_resolve, reject) => {
        // Like fetch: rejects at once when already aborted, and later when it aborts.
        if (req.signal?.aborted) reject(new Error("fetch aborted"));
        req.signal?.addEventListener("abort", () => {
          reject(new Error("fetch aborted"));
        });
      });
    };
  };

  it("hands the caller's signal to the adapter and ledgers an aborted call with estimated usage", async () => {
    const { caller, ledger, provider } = setup(10_000);
    const seen: { value?: AbortSignal | undefined } = {};
    blockUntilAborted(provider, seen);
    const ac = new AbortController();

    const run = (async () => {
      for await (const ev of caller.chat(
        "interview_turn",
        { companyId: "c1", sessionId: "s1" },
        request(ac.signal),
      )) {
        if (ev.type === "text") ac.abort();
      }
    })();

    await expect(run).rejects.toBeInstanceOf(CallAbortedError);
    expect(seen.value).toBe(ac.signal);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ status: "aborted", sessionId: "s1" });
    // Not free: the prompt was sent and some of the answer arrived.
    expect(ledger.entries[0]!.usage.inputTokens).toBeGreaterThan(0);
    expect(ledger.entries[0]!.usage.outputTokens).toBeGreaterThan(0);
    expect(ledger.entries[0]!.costCents).toBeGreaterThan(0);
  });

  it("stops an adapter that ignores the signal at the next event", async () => {
    const { caller, ledger } = setup(10_000);
    const ac = new AbortController();
    const seen: string[] = [];

    const run = (async () => {
      // The fake provider emits "ok" then "done" without looking at the signal.
      for await (const ev of caller.chat("interview_turn", { companyId: "c1" }, request(ac.signal))) {
        seen.push(ev.type);
        ac.abort();
      }
    })();

    await expect(run).rejects.toBeInstanceOf(CallAbortedError);
    expect(seen).toEqual(["text"]);
    expect(ledger.entries[0]).toMatchObject({ status: "aborted" });
  });

  it("does not call the provider or write a ledger row for a signal that is already aborted", async () => {
    const { caller, ledger, provider } = setup(10_000);
    const ac = new AbortController();
    ac.abort();

    await expect(
      caller.complete(
        "interview_turn",
        { companyId: "c1" },
        request(ac.signal),
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toBeInstanceOf(CallAbortedError);
    await expect(
      caller.chat("interview_turn", { companyId: "c1" }, request(ac.signal))[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(CallAbortedError);

    expect(provider.lastReq).toBeUndefined();
    expect(ledger.entries).toHaveLength(0);
  });

  it("records a consumer that walks away mid-stream as aborted rather than as a free ok call", async () => {
    const { caller, ledger } = setup(10_000);

    for await (const ev of caller.chat(
      "interview_turn",
      { companyId: "c1" },
      { messages: [{ role: "user", content: "hi" }] },
    )) {
      if (ev.type === "text") break;
    }

    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ status: "aborted" });
  });

  it("aborts a structured call and records it", async () => {
    const { caller, ledger, provider } = setup(10_000);
    const ac = new AbortController();
    provider.complete = async (_m: string, req: ChatRequest): Promise<never> => {
      ac.abort();
      if (req.signal?.aborted) throw new Error("fetch aborted");
      throw new Error("signal was not passed");
    };

    await expect(
      caller.complete(
        "interview_turn",
        { companyId: "c1" },
        request(ac.signal),
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toBeInstanceOf(CallAbortedError);

    expect(ledger.entries[0]).toMatchObject({ status: "aborted" });
  });
});

describe("ModelCaller.probe (D-106)", () => {
  const target = { providerId: "p1", model: "m" };

  it("ledgers one priced row under purpose probe, referencing the provider, and skips routing", async () => {
    const { caller, ledger } = setup(10_000);

    const r = await caller.probe({ companyId: "c1" }, target);

    expect(r).toMatchObject({ text: "ok", ledgered: true });
    expect(r.costCents).toBeCloseTo(0.2, 9);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      purpose: "probe",
      companyId: "c1",
      providerId: "p1",
      status: "ok",
      ref: { type: "provider", id: "p1" },
    });
  });

  it("is exempt from budgets: a spent tenant can still test its provider", async () => {
    const { caller, ledger } = setup(0);

    await expect(caller.probe({ companyId: "c1" }, target)).resolves.toMatchObject({ ledgered: true });
    expect(ledger.entries.map((e) => e.status)).toEqual(["ok"]);
  });

  it("is refused by the guard before any request is made", async () => {
    const { provider } = setup(10_000);
    const registry = new ProviderRegistry();
    (registry as unknown as { cache: Map<string, unknown> }).cache.set("p1", { config: cfg, provider });
    const ledger = new InMemoryLedger();
    const caller = new ModelCaller({
      routes: { resolve: async () => undefined },
      providerConfigs: { get: async () => cfg },
      registry,
      prices: new PriceTable(),
      ledger,
      budget: new BudgetGuard(new StaticBudgetLimits([]), ledger),
      probeGuard: {
        check: async () => {
          throw new ProbeLimitError(3);
        },
      },
    });

    await expect(caller.probe({ companyId: "c1" }, target)).rejects.toBeInstanceOf(ProbeLimitError);

    expect(provider.lastReq).toBeUndefined();
    expect(ledger.entries).toHaveLength(0);
  });

  it("cannot pin a provider the tenant is not allowed to use", async () => {
    const registry = new ProviderRegistry();
    const ledger = new InMemoryLedger();
    const caller = new ModelCaller({
      routes: { resolve: async () => undefined },
      // The config source is the tenant boundary: it knows only this tenant's and platform providers.
      providerConfigs: { get: async (company, id) => (company === "c1" && id === "mine" ? cfg : undefined) },
      registry,
      prices: new PriceTable(),
      ledger,
      budget: new BudgetGuard(new StaticBudgetLimits([]), ledger),
    });

    await expect(
      caller.probe({ companyId: "c1" }, { providerId: "someone-elses", model: "m" }),
    ).rejects.toThrow(/not available to this tenant/);
    expect(ledger.entries).toHaveLength(0);
  });

  it("ledgers a failed probe as an error and does not ledger a platform-level one", async () => {
    const { caller, ledger, provider } = setup(10_000);
    provider.chat = async function* () {
      yield* [];
      throw new Error("connection refused");
    };

    await expect(caller.probe({ companyId: "c1" }, target)).rejects.toThrow("connection refused");
    expect(ledger.entries.map((e) => e.status)).toEqual(["error"]);

    const platform = setup(10_000);
    const r = await platform.caller.probe({ companyId: null }, target);
    expect(r.ledgered).toBe(false);
    expect(platform.ledger.entries).toHaveLength(0);
  });
});

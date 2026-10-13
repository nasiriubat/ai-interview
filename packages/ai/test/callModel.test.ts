import type { Capabilities, ChatEvent, ChatRequest, ProviderConfig, Route } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelCaller, type ModelCallerDeps } from "../src/callModel.js";
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
    streamingTranscription: false,
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

function setup(limitCents: number, onBudgetExceeded?: ModelCallerDeps["onBudgetExceeded"]) {
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
    ...(onBudgetExceeded ? { onBudgetExceeded } : {}),
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

  describe("onBudgetExceeded", () => {
    const refused = async (caller: ModelCaller): Promise<BudgetExceededError> => {
      const it = caller.chat(
        "interview_turn",
        { companyId: "c1", sessionId: "s1" },
        { messages: [{ role: "user", content: "hi" }], cachePrefix: false },
      );
      try {
        await it[Symbol.asyncIterator]().next();
      } catch (e) {
        return e as BudgetExceededError;
      }
      throw new Error("the call was not refused");
    };

    it("hears every refusal, after the ledger row, and marks the error with what it answered", async () => {
      const seen: unknown[] = [];
      const { caller, ledger } = setup(0.01, async (ctx, check) => {
        // The refusal is already on the ledger by the time anyone is told.
        expect(ledger.entries).toHaveLength(1);
        seen.push({ ctx, blockedBy: check.blockedBy?.scope });
        return { notified: true };
      });
      const err = await refused(caller);
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect(err.notified).toBe(true);
      expect(seen).toEqual([{ ctx: { companyId: "c1", sessionId: "s1" }, blockedBy: "tenant" }]);
    });

    it("leaves notified false when nobody was told, and when the hook itself fails", async () => {
      const silent = await refused(setup(0.01, async () => undefined).caller);
      expect(silent.notified).toBe(false);
      const broken = await refused(
        setup(0.01, async () => {
          throw new Error("alerting is down");
        }).caller,
      );
      expect(broken).toBeInstanceOf(BudgetExceededError);
      expect(broken.notified).toBe(false);
      expect(new BudgetExceededError({ allowed: false, warnings: [] }).notified).toBe(false);
    });

    it("hears a refusal from structured completion as well as from streaming", async () => {
      const heard: string[] = [];
      const { caller } = setup(0, async (_ctx, check) => {
        heard.push(check.blockedBy?.scope ?? "?");
        return { notified: true };
      });
      await expect(
        caller.complete(
          "interview_turn",
          { companyId: "c1" },
          { messages: [{ role: "user", content: "hi" }] },
          z.object({ ok: z.boolean() }),
        ),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(heard).toEqual(["tenant"]);
    });
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

import type { Capabilities, ChatEvent, ChatRequest, ProviderConfig, Route } from "@aidp/shared";
import { emptyUsage } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ModelCaller, type FallbackNotice } from "../src/callModel.js";
import { BudgetGuard, StaticBudgetLimits } from "../src/cost/budget.js";
import { InMemoryLedger } from "../src/cost/ledger.js";
import { PriceTable } from "../src/cost/pricing.js";
import { CircuitBreaker, countsAgainstProvider } from "../src/providers/breaker.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { ProviderError, type Provider } from "../src/providers/types.js";

const caps: Capabilities = {
  caching: false,
  structuredOutput: true,
  effort: false,
  batch: false,
  vision: false,
  transcription: false,
  speech: false,
  streamingTranscription: false,
};

/** A provider that fails on demand, with the error the test names. */
class FailingProvider implements Provider {
  readonly kind = "openai" as const;
  readonly capabilities = caps;
  calls = 0;
  mode: "ok" | "fail" | "bad_request" = "fail";
  constructor(readonly id: string) {}
  async listModels() {
    return [];
  }
  async *chat(_m: string, _r: ChatRequest): AsyncIterable<ChatEvent> {
    this.calls++;
    if (this.mode === "fail") throw new ProviderError("Provider returned 503", "server", true);
    if (this.mode === "bad_request") throw new ProviderError("Provider returned 400", "bad_request", false);
    yield { type: "text", text: `from ${this.id}` };
    yield {
      type: "done",
      usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
      model: "m",
    };
  }
  async complete<T>(_m: string, _r: ChatRequest, schema: z.ZodType<T>) {
    this.calls++;
    if (this.mode === "fail") throw new ProviderError("Provider returned 503", "server", true);
    return { value: schema.parse({ from: this.id }), usage: emptyUsage() };
  }
}

const cfg = (id: string): ProviderConfig => ({
  id,
  companyId: null,
  kind: "openai",
  name: id,
  apiKey: "k",
  headers: {},
  enabled: true,
});

const route = (providerId: string): Route => ({
  companyId: null,
  purpose: "interview_turn",
  providerId,
  model: "m",
  maxOutputTokens: 100,
  batchAllowed: false,
});

function setup(options: { withFallback: boolean }) {
  const primary = new FailingProvider("primary");
  const backup = new FailingProvider("backup");
  backup.mode = "ok";
  const registry = new ProviderRegistry();
  const cache = (registry as unknown as { cache: Map<string, unknown> }).cache;
  cache.set("primary", { config: cfg("primary"), provider: primary });
  cache.set("backup", { config: cfg("backup"), provider: backup });
  const ledger = new InMemoryLedger();
  const clock = { t: 0 };
  const notices: FallbackNotice[] = [];
  const transitions: string[] = [];
  const breaker = new CircuitBreaker({
    failures: 3,
    windowMs: 60_000,
    openMs: 30_000,
    now: () => clock.t,
    onChange: (id, from, to) => transitions.push(`${id}:${from}->${to}`),
  });
  const caller = new ModelCaller({
    routes: { resolve: async () => route("primary") },
    providerConfigs: { get: async (_c, id) => cfg(id) },
    registry,
    prices: new PriceTable(),
    ledger,
    budget: new BudgetGuard(new StaticBudgetLimits([]), ledger),
    breaker,
    ...(options.withFallback
      ? {
          fallbackRoutes: { resolve: async () => route("backup") },
          onFallback: (n: FallbackNotice) => notices.push(n),
        }
      : {}),
  });
  return { caller, primary, backup, ledger, clock, notices, breaker, transitions };
}

const ctx = { companyId: "c1", sessionId: "s1" };
const req = { messages: [{ role: "user" as const, content: "hi" }] };

async function chatText(caller: ModelCaller): Promise<string> {
  let out = "";
  for await (const ev of caller.chat("interview_turn", ctx, req)) if (ev.type === "text") out += ev.text;
  return out;
}

describe("CircuitBreaker (D-228)", () => {
  it("opens after the threshold within the window, probes once when the open period passes", () => {
    const clock = { t: 0 };
    const b = new CircuitBreaker({ failures: 3, windowMs: 1000, openMs: 500, now: () => clock.t });
    for (let i = 0; i < 2; i++) b.failure("p");
    expect(b.state("p")).toBe("closed");
    b.failure("p");
    expect(b.state("p")).toBe("open");
    expect(b.tryAcquire("p")).toBe(false);

    clock.t = 600;
    expect(b.state("p")).toBe("half_open");
    expect(b.tryAcquire("p")).toBe(true); // the probe
    expect(b.tryAcquire("p")).toBe(false); // only one at a time

    b.failure("p"); // probe failed: open again
    expect(b.state("p")).toBe("open");
    clock.t = 1200;
    expect(b.tryAcquire("p")).toBe(true);
    b.success("p");
    expect(b.state("p")).toBe("closed");
    expect(b.tryAcquire("p")).toBe(true);
  });

  it("forgets failures that fall outside the window", () => {
    const clock = { t: 0 };
    const b = new CircuitBreaker({ failures: 3, windowMs: 1000, now: () => clock.t });
    b.failure("p");
    b.failure("p");
    clock.t = 2000;
    b.failure("p");
    expect(b.state("p")).toBe("closed");
  });

  it("counts only failures that say something about the provider", () => {
    expect(countsAgainstProvider(new ProviderError("x", "server", true))).toBe(true);
    expect(countsAgainstProvider(new ProviderError("x", "timeout", true))).toBe(true);
    expect(countsAgainstProvider(new ProviderError("x", "rate_limit", true))).toBe(true);
    expect(countsAgainstProvider(new ProviderError("x", "bad_request", false))).toBe(false);
    expect(countsAgainstProvider(new ProviderError("x", "auth", false))).toBe(false);
    expect(countsAgainstProvider(new Error("boom"))).toBe(false);
  });
});

describe("ModelCaller with a failing provider", () => {
  it("serves the call from the fallback route when the primary fails before output", async () => {
    const { caller, primary, backup, ledger, notices } = setup({ withFallback: true });
    expect(await chatText(caller)).toBe("from backup");
    expect(primary.calls).toBe(1);
    expect(backup.calls).toBe(1);
    // Two honest rows: the failed primary attempt and the fallback that served the turn.
    expect(ledger.entries.map((e) => [e.providerId, e.status, e.routeTier])).toEqual([
      ["primary", "error", undefined],
      ["backup", "ok", "fallback"],
    ]);
    expect(notices).toEqual([
      {
        companyId: "c1",
        purpose: "interview_turn",
        fromProviderId: "primary",
        toProviderId: "backup",
        reason: "error",
      },
    ]);
  });

  it("opens the circuit after repeated failures and then skips the primary altogether", async () => {
    const { caller, primary, backup, notices, breaker, transitions } = setup({ withFallback: true });
    for (let i = 0; i < 3; i++) await chatText(caller);
    expect(breaker.state("primary")).toBe("open");
    expect(transitions).toContain("primary:closed->open");
    const before = primary.calls;
    expect(await chatText(caller)).toBe("from backup");
    expect(primary.calls).toBe(before); // not even tried
    expect(backup.calls).toBe(4);
    expect(notices.at(-1)?.reason).toBe("circuit_open");
  });

  it("fails fast with a retryable error when the circuit is open and there is no fallback", async () => {
    const { caller, primary } = setup({ withFallback: false });
    for (let i = 0; i < 3; i++) await expect(chatText(caller)).rejects.toMatchObject({ code: "server" });
    const calls = primary.calls;
    const err = await chatText(caller).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect(primary.calls).toBe(calls);
  });

  it("closes the circuit again when the half-open probe succeeds", async () => {
    const { caller, primary, breaker, clock } = setup({ withFallback: true });
    for (let i = 0; i < 3; i++) await chatText(caller);
    expect(breaker.state("primary")).toBe("open");
    primary.mode = "ok";
    clock.t = 31_000;
    expect(await chatText(caller)).toBe("from primary");
    expect(breaker.state("primary")).toBe("closed");
  });

  it("does not trip the circuit on a request the provider rejected as invalid", async () => {
    const { caller, primary, breaker } = setup({ withFallback: true });
    primary.mode = "bad_request";
    for (let i = 0; i < 5; i++) await expect(chatText(caller)).rejects.toMatchObject({ code: "bad_request" });
    expect(breaker.state("primary")).toBe("closed");
  });

  it("falls back for structured calls too", async () => {
    const { caller, ledger } = setup({ withFallback: true });
    const out = await caller.complete(
      "interview_turn",
      ctx,
      req,
      (await import("zod")).z.object({ from: (await import("zod")).z.string() }),
    );
    expect(out).toEqual({ from: "backup" });
    expect(ledger.entries.at(-1)?.routeTier).toBe("fallback");
  });
});

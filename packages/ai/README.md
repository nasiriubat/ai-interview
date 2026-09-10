# @aidp/ai

Provider layer, cost control, and (next) the interview engines. Spec: `docs/spec/08-providers-and-cost.md` and `docs/spec/10-architecture.md`.

## Rule

No code calls a provider adapter directly. Everything goes through `ModelCaller`, which
resolves the route for the purpose, checks budgets, invokes the adapter, and writes the
ledger row whether the call succeeds, fails, is refused, or is blocked by budget.

```ts
const caller = new ModelCaller({ routes, providerConfigs, registry, prices, ledger, budget });
for await (const ev of caller.chat("interview_turn", { companyId, interviewId }, { system, messages, cachePrefix: true })) {
  if (ev.type === "text") send(ev.text);
}
const facts = await caller.complete("extraction", ctx, { messages }, ExtractionResultSchema);
```

## Adapters

| Kind | Class | Notes |
|---|---|---|
| `anthropic` | `AnthropicProvider` | Official SDK. Prompt caching on the system prefix, `output_config.effort`, structured output through `messages.parse`. |
| `openai`, `openrouter`, `litellm`, `openai_compatible` | `OpenAICompatibleProvider` | Chat Completions protocol. Streams with usage, `json_schema` structured output with JSON-mode fallback, audio transcription, model list with prices from OpenRouter and LiteLLM. |

Capabilities are explicit on each adapter; `ModelCaller` only passes effort and cache
markers where the adapter supports them.

## Cost

- `PriceTable`: per provider and model, seeded for Anthropic, importable from provider model lists, admin overrides win.
- `costCents(price, usage)` and `estimateCents(price, inputTokens, maxOutputTokens)`.
- `BudgetGuard`: tenant, campaign, and interview limits, monthly or total, warning at 80 percent, hard stop at 100.
- `InMemoryLedger`: reference implementation of `LedgerSink` and `SpendSource`; the database version in `packages/db` implements the same interfaces.

## Tests

`pnpm test` runs unit tests with fakes for the SDK and `fetch`. No network, no keys.

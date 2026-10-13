import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { ProviderError } from "../src/providers/types.js";

function sseResponse(lines: string[]): Response {
  const body = lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new Blob([body]).stream(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenAICompatibleProvider", () => {
  it("streams text deltas and reads usage from the final chunk, with cached tokens split out", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchMock: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return sseResponse([
        JSON.stringify({ model: "gpt-x", choices: [{ delta: { content: "Hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }),
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
        }),
      ]);
    };
    const p = new OpenAICompatibleProvider({ id: "or", kind: "openrouter", apiKey: "k", fetch: fetchMock });
    const events = [];
    for await (const ev of p.chat("gpt-x", {
      messages: [{ role: "user", content: "hi" }],
      system: "sys",
      maxOutputTokens: 50,
      cachePrefix: false,
    }))
      events.push(ev);
    expect(events).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      {
        type: "done",
        usage: { inputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0, outputTokens: 5 },
        stopReason: "end_turn",
        model: "gpt-x",
      },
    ]);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
  });

  it("ties the request to the caller's signal, for chat and for structured output", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      seen.push(init?.signal);
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (body.stream) return sseResponse([JSON.stringify({ choices: [{ delta: { content: "x" } }] })]);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
      });
    };
    const p = new OpenAICompatibleProvider({ id: "oa", kind: "openai", apiKey: "k", fetch: fetchMock });
    const ac = new AbortController();
    const req = {
      messages: [{ role: "user" as const, content: "hi" }],
      maxOutputTokens: 10,
      cachePrefix: false,
      signal: ac.signal,
    };

    for await (const _ of p.chat("m", req));
    await p.complete("m", req, z.object({ ok: z.boolean() }));

    // The request carries the caller's signal combined with the adapter's own deadline (D-93), so
    // it is a derived signal, not the same object: it must follow the caller's abort.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) expect(s?.aborted).toBe(false);
    ac.abort();
    for (const s of seen) expect(s?.aborted).toBe(true);
  });

  it("falls back to JSON mode when the server rejects json_schema, and validates locally", async () => {
    let n = 0;
    const fetchMock: typeof fetch = async (_url, init) => {
      n++;
      const body = JSON.parse(String(init?.body));
      if (body.response_format?.type === "json_schema") return new Response("unsupported", { status: 400 });
      return Response.json({
        choices: [{ message: { content: '```json\n{"name":"Ada","age":36}\n```' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    };
    const p = new OpenAICompatibleProvider({
      id: "ll",
      kind: "litellm",
      baseUrl: "http://litellm:4000/",
      apiKey: "k",
      fetch: fetchMock,
    });
    const res = await p.complete(
      "m",
      { messages: [{ role: "user", content: "x" }], maxOutputTokens: 100, cachePrefix: false },
      z.object({ name: z.string(), age: z.number() }),
    );
    expect(n).toBe(2);
    expect(res.value).toEqual({ name: "Ada", age: 36 });
    expect(res.usage.outputTokens).toBe(8);
  });

  it("imports OpenRouter per-token prices as per-million", async () => {
    const fetchMock: typeof fetch = async () =>
      Response.json({
        data: [
          {
            id: "anthropic/claude-sonnet-5",
            name: "Sonnet 5",
            context_length: 1000000,
            pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002" },
          },
        ],
      });
    const p = new OpenAICompatibleProvider({ id: "or", kind: "openrouter", apiKey: "k", fetch: fetchMock });
    const models = await p.listModels();
    expect(models[0]).toMatchObject({
      id: "anthropic/claude-sonnet-5",
      contextWindow: 1000000,
      inputPerMtok: 2,
      outputPerMtok: 10,
    });
    expect(models[0]!.cachedInputPerMtok).toBeCloseTo(0.2, 9);
  });

  it("reads LiteLLM /model/info prices", async () => {
    const fetchMock: typeof fetch = async (url) => {
      if (String(url).endsWith("/model/info"))
        return Response.json({
          data: [
            {
              model_name: "fast",
              model_info: {
                input_cost_per_token: 0.000001,
                output_cost_per_token: 0.000005,
                max_input_tokens: 128000,
              },
            },
          ],
        });
      return Response.json({ data: [] });
    };
    const p = new OpenAICompatibleProvider({
      id: "ll",
      kind: "litellm",
      baseUrl: "http://litellm:4000",
      apiKey: "k",
      fetch: fetchMock,
    });
    expect(await p.listModels()).toEqual([
      { id: "fast", name: "fast", contextWindow: 128000, inputPerMtok: 1, outputPerMtok: 5 },
    ]);
  });

  it("maps HTTP errors to typed provider errors", async () => {
    const fetchMock: typeof fetch = async () => new Response("slow down", { status: 429 });
    // Retried with backoff before it is reported (D-93); the sleep is replaced so the test is not.
    const p = new OpenAICompatibleProvider({
      id: "oa",
      kind: "openai",
      apiKey: "k",
      fetch: fetchMock,
      sleep: async () => undefined,
    });
    await expect(p.listModels()).rejects.toMatchObject({
      name: "ProviderError",
      code: "rate_limit",
      retryable: true,
    });
  });

  it("requires a base URL for litellm and generic providers", () => {
    expect(() => new OpenAICompatibleProvider({ id: "x", kind: "litellm", apiKey: "k" })).toThrow(
      ProviderError,
    );
  });
});

describe("structured output against providers that ignore json_schema (seen with OpenRouter)", () => {
  const Facts = z.object({ facts: z.array(z.object({ name: z.string() })) });

  it("states the schema in the prompt, retries in JSON mode when the strict answer has the wrong shape, and reads JSON out of fences and prose", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const rf = body.response_format as { type: string };
      if (rf.type === "json_schema")
        return Response.json({
          choices: [{ message: { content: '```json\n{"activity":"invoices"}\n```' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 8 },
        });
      return Response.json({
        choices: [
          {
            message: { content: 'Here you go:\n```json\n{"facts":[{"name":"Invoices"}]}\n```\nDone.' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 9 },
      });
    };
    const p = new OpenAICompatibleProvider({ id: "or", kind: "openrouter", apiKey: "k", fetch: fetchMock });
    const res = await p.complete(
      "m",
      { messages: [{ role: "user", content: "x" }], maxOutputTokens: 100, cachePrefix: false },
      Facts,
      "facts",
    );
    expect(res.value).toEqual({ facts: [{ name: "Invoices" }] });
    expect(res.usage.outputTokens).toBe(9);
    expect(bodies).toHaveLength(2);
    const first = bodies[0] as { messages: { role: string; content: string }[]; provider?: unknown };
    expect(first.messages[0]?.role).toBe("system");
    expect(first.messages[0]?.content).toContain('"facts"');
    expect(first.provider).toEqual({ require_parameters: true });
  });

  it("reports truncation instead of a bare JSON error", async () => {
    const fetchMock: typeof fetch = async () =>
      Response.json({ choices: [{ message: { content: '{"facts":[{"name":"a' }, finish_reason: "length" }] });
    const p = new OpenAICompatibleProvider({ id: "or", kind: "openrouter", apiKey: "k", fetch: fetchMock });
    await expect(
      p.complete(
        "m",
        { messages: [{ role: "user", content: "x" }], maxOutputTokens: 5, cachePrefix: false },
        Facts,
      ),
    ).rejects.toThrow(/cut off by max_tokens/);
  });

  it("extractJsonValue finds the first balanced object or array", async () => {
    const { extractJsonValue } = await import("../src/providers/openai-compatible.js");
    expect(extractJsonValue('text ```json\n[{"a":"}"}]\n``` more')).toBe('[{"a":"}"}]');
    expect(extractJsonValue('{"a":{"b":[1,2]}} trailing')).toBe('{"a":{"b":[1,2]}}');
    expect(extractJsonValue("no json here")).toBeUndefined();
    expect(extractJsonValue('{"unbalanced": [1, 2')).toBeUndefined();
  });
});

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import {
  DEFAULT_TIMEOUTS,
  backoffMs,
  guardStream,
  retryAfterMs,
  timeoutsFromEnv,
  type ProviderTimeouts,
} from "../src/providers/resilience.js";
import { ProviderError } from "../src/providers/types.js";

const fast: ProviderTimeouts = { totalMs: 400, firstTokenMs: 60, idleMs: 60, maxRetries: 2 };
const noSleep = async (): Promise<void> => undefined;
const req = {
  messages: [{ role: "user" as const, content: "hi" }],
  maxOutputTokens: 50,
  cachePrefix: false,
};

/** Reads a stream to its end, for the tests that only care how it ends. */
async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _item of it) {
    // consumed
  }
}

/** The error an aborted fetch rejects with. */
const abortReason = (signal: AbortSignal | null | undefined): Error =>
  signal?.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");

/** A fetch that never answers on its own and honours the abort signal like the real one. */
const hangingFetch: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(abortReason(init.signal));
    });
  });

const enc = new TextEncoder();
const sse = (chunk: object): Uint8Array => enc.encode(`data: ${JSON.stringify(chunk)}\n\n`);

/** An SSE body the test pushes into, and which records whether the connection was cancelled. */
function liveBody(signal?: AbortSignal | null): {
  response: Response;
  push: (chunk: object) => void;
  close: () => void;
  cancelled: () => boolean;
} {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
    cancel() {
      wasCancelled = true;
    },
  });
  signal?.addEventListener("abort", () => {
    wasCancelled = true;
    ctl.error(abortReason(signal));
  });
  return {
    response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (c) => {
      ctl.enqueue(sse(c));
    },
    close: () => {
      ctl.close();
    },
    cancelled: () => wasCancelled,
  };
}

describe("timeoutsFromEnv", () => {
  it("defaults to the documented limits", () => {
    expect(timeoutsFromEnv({})).toEqual(DEFAULT_TIMEOUTS);
  });

  it("reads the ceiling and clamps the streaming deadlines under it", () => {
    const t = timeoutsFromEnv({
      PROVIDER_TIMEOUT_MS: "10000",
      PROVIDER_FIRST_TOKEN_TIMEOUT_MS: "60000",
      PROVIDER_IDLE_TIMEOUT_MS: "5000",
      PROVIDER_MAX_RETRIES: "1",
    });
    expect(t).toEqual({ totalMs: 10_000, firstTokenMs: 10_000, idleMs: 5_000, maxRetries: 1 });
  });

  it("keeps every value inside hard bounds, and falls back on garbage rather than failing boot", () => {
    expect(timeoutsFromEnv({ PROVIDER_TIMEOUT_MS: "99999999999" }).totalMs).toBe(600_000);
    expect(timeoutsFromEnv({ PROVIDER_TIMEOUT_MS: "5" }).totalMs).toBe(1_000);
    expect(timeoutsFromEnv({ PROVIDER_MAX_RETRIES: "50" }).maxRetries).toBe(5);
    expect(timeoutsFromEnv({ PROVIDER_MAX_RETRIES: "-3" }).maxRetries).toBe(0);
    expect(timeoutsFromEnv({ PROVIDER_TIMEOUT_MS: "soon" })).toEqual(DEFAULT_TIMEOUTS);
    expect(timeoutsFromEnv({ PROVIDER_MAX_RETRIES: "1.5" }).maxRetries).toBe(DEFAULT_TIMEOUTS.maxRetries);
  });
});

describe("backoff", () => {
  it("doubles from 300 ms with jitter and stops at 4 s", () => {
    expect(backoffMs(1, () => 0)).toBe(150);
    expect(backoffMs(1, () => 1)).toBe(300);
    expect(backoffMs(2, () => 1)).toBe(600);
    expect(backoffMs(10, () => 1)).toBe(4000);
  });

  it("honours a short Retry-After and ignores a hostile one", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs("3600")).toBe(5000);
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe("guardStream", () => {
  async function* never(): AsyncGenerator<number> {
    await new Promise(() => undefined);
    yield 1;
  }

  it("fails a source that produces nothing, and aborts it", async () => {
    let aborted = false;
    const it = guardStream(never(), {
      firstMs: 30,
      idleMs: 1000,
      label: "stream",
      abort: () => {
        aborted = true;
      },
    });
    await expect(it.next()).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(aborted).toBe(true);
  });

  it("does not let keep-alives that are not output restart the first-output clock", async () => {
    async function* chatter(): AsyncGenerator<string> {
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 10));
        yield "keepalive";
      }
    }
    const seen: string[] = [];
    const run = (async () => {
      for await (const s of guardStream(chatter(), {
        firstMs: 60,
        idleMs: 1000,
        isOutput: (s) => s !== "keepalive",
        label: "stream",
        abort: () => undefined,
      }))
        seen.push(s);
    })();
    // Keep-alives pass through, but they do not count as output: the 60 ms still runs out.
    await expect(run).rejects.toMatchObject({ code: "timeout" });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.length).toBeLessThan(50);
  });

  it("applies the idle limit once output has started, and passes a healthy stream through", async () => {
    async function* gap(): AsyncGenerator<string> {
      yield "a";
      await new Promise(() => undefined);
    }
    const it = guardStream(gap(), { firstMs: 1000, idleMs: 30, label: "s", abort: () => undefined });
    expect((await it.next()).value).toBe("a");
    await expect(it.next()).rejects.toMatchObject({ code: "timeout" });

    async function* fine(): AsyncGenerator<number> {
      yield 1;
      yield 2;
    }
    const out: number[] = [];
    for await (const v of guardStream(fine(), {
      firstMs: 50,
      idleMs: 50,
      label: "s",
      abort: () => undefined,
    }))
      out.push(v);
    expect(out).toEqual([1, 2]);
  });
});

describe("OpenAICompatibleProvider deadlines and retries", () => {
  const make = (fetchImpl: typeof fetch, timeouts: ProviderTimeouts = fast) =>
    new OpenAICompatibleProvider({
      id: "oa",
      kind: "openai",
      apiKey: "k",
      fetch: fetchImpl,
      timeouts,
      sleep: noSleep,
    });

  it("times out a provider that never answers, as a retryable timeout, and does not run it again", async () => {
    let calls = 0;
    const fetchMock: typeof fetch = (url, init) => {
      calls++;
      return hangingFetch(url, init);
    };
    const p = make(fetchMock, { ...fast, totalMs: 50 });
    const started = Date.now();
    const failure = await p.listModels().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ code: "timeout", retryable: true });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("retries a 503 a bounded number of times and then reports it", async () => {
    let calls = 0;
    const p = make(async () => {
      calls++;
      return new Response("busy", { status: 503 });
    });
    await expect(p.listModels()).rejects.toMatchObject({ code: "server", retryable: true });
    expect(calls).toBe(1 + fast.maxRetries);
  });

  it("recovers when a retry succeeds", async () => {
    let calls = 0;
    const p = make(async () => {
      calls++;
      return calls < 3 ? new Response("busy", { status: 503 }) : Response.json({ data: [{ id: "m" }] });
    });
    await expect(p.listModels()).resolves.toHaveLength(1);
    expect(calls).toBe(3);
  });

  it("retries a network error, but never a bad key or a bad request", async () => {
    let calls = 0;
    const flaky = make(async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return Response.json({ data: [] });
    });
    await expect(flaky.listModels()).resolves.toEqual([]);
    expect(calls).toBe(2);

    for (const [status, code] of [
      [401, "auth"],
      [400, "bad_request"],
      [404, "not_found"],
    ] as const) {
      let n = 0;
      const p = make(async () => {
        n++;
        return new Response("no", { status });
      });
      await expect(p.listModels()).rejects.toMatchObject({ code });
      expect(n).toBe(1);
    }
  });

  it("waits Retry-After on a 429 and does not retry once the caller has aborted", async () => {
    const waits: number[] = [];
    let calls = 0;
    const p = new OpenAICompatibleProvider({
      id: "oa",
      kind: "openai",
      apiKey: "k",
      timeouts: fast,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response("slow", { status: 429, headers: { "retry-after": "2" } })
          : Response.json({ data: [] });
      },
    });
    await p.listModels();
    expect(waits).toEqual([2000]);

    const controller = new AbortController();
    let speakCalls = 0;
    const speaker = new OpenAICompatibleProvider({
      id: "oa",
      kind: "openai",
      apiKey: "k",
      timeouts: fast,
      sleep: noSleep,
      fetch: async (_u, init) => {
        speakCalls++;
        controller.abort();
        throw init?.signal?.reason ?? new DOMException("aborted", "AbortError");
      },
    });
    await expect(speaker.speak("tts-1", { text: "hello" }, controller.signal)).rejects.toMatchObject({
      code: "network",
    });
    expect(speakCalls).toBe(1);
  });

  it("passes the caller's abort signal to the HTTP call (barge-in used to be dropped on the floor)", async () => {
    let seen: AbortSignal | null | undefined;
    const controller = new AbortController();
    const p = make(async (_u, init) => {
      seen = init?.signal;
      return new Response(new Blob(["x"]).stream(), { status: 200 });
    });
    await p.speak("tts-1", { text: "hi" }, controller.signal);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });

  it("fails a stream that sends nothing within the first-token deadline and cancels the connection", async () => {
    let body: ReturnType<typeof liveBody> | undefined;
    const p = make(async (_u, init) => {
      body = liveBody(init?.signal);
      // The role-only opening chunk is not output.
      body.push({ choices: [{ delta: { role: "assistant" } }] });
      return body.response;
    });
    const failure = await (async () => {
      try {
        await drain(p.chat("m", req));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(failure).toMatchObject({ code: "timeout", retryable: true });
    expect(body?.cancelled()).toBe(true);
  });

  it("fails a stream that goes quiet after it started, keeping what it had sent", async () => {
    const texts: string[] = [];
    const p = make(async (_u, init) => {
      const body = liveBody(init?.signal);
      body.push({ choices: [{ delta: { content: "Hel" } }] });
      return body.response;
    });
    let failure: unknown;
    try {
      for await (const ev of p.chat("m", req)) if (ev.type === "text") texts.push(ev.text);
    } catch (e) {
      failure = e;
    }
    expect(texts).toEqual(["Hel"]);
    expect(failure).toMatchObject({ code: "timeout" });
  });

  it("maps a connection that drops mid-stream to a retryable network error", async () => {
    const p = make(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(sse({ choices: [{ delta: { content: "Hi" } }] }));
          c.error(new TypeError("terminated"));
        },
      });
      return new Response(stream, { status: 200 });
    });
    let failure: unknown;
    try {
      await drain(p.chat("m", req));
    } catch (e) {
      failure = e;
    }
    expect(failure).toMatchObject({ code: "network", retryable: true });
  });
});

describe("AnthropicProvider deadlines", () => {
  it("builds its client with the explicit timeout and retry limit", () => {
    const p = new AnthropicProvider({
      id: "a",
      apiKey: "k",
      timeouts: { ...fast, totalMs: 7_000, maxRetries: 1 },
    });
    const client = (p as unknown as { client: Anthropic }).client;
    expect(client.timeout).toBe(7_000);
    expect(client.maxRetries).toBe(1);
  });

  it("fails a stream that never produces a content delta, and aborts it", async () => {
    let aborted = false;
    const client = {
      messages: {
        stream() {
          return Object.assign(
            (async function* () {
              yield { type: "message_start" };
              await new Promise(() => undefined);
            })(),
            {
              abort: () => {
                aborted = true;
              },
              finalMessage: async () => ({}),
            },
          );
        },
      },
    } as unknown as Anthropic;
    const p = new AnthropicProvider({ id: "a", apiKey: "k", client, timeouts: fast });
    let failure: unknown;
    try {
      await drain(p.chat("claude", req));
    } catch (e) {
      failure = e;
    }
    expect(failure).toMatchObject({ code: "timeout", retryable: true });
    expect(aborted).toBe(true);
  });

  it("maps the SDK's own connection timeout to a timeout, not a network error", async () => {
    const client = {
      messages: {
        stream() {
          throw new Anthropic.APIConnectionTimeoutError();
        },
      },
    } as unknown as Anthropic;
    const p = new AnthropicProvider({ id: "a", apiKey: "k", client, timeouts: fast });
    let failure: unknown;
    try {
      await drain(p.chat("claude", req));
    } catch (e) {
      failure = e;
    }
    expect(failure).toMatchObject({ code: "timeout", retryable: true });
  });
});

describe("caller signal and deadline together (both adapters)", () => {
  const schema = z.object({ ok: z.boolean() });

  it("anthropic: the stream and the structured call carry the caller's signal combined with the deadline", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const client = {
      messages: {
        stream(_params: unknown, opts?: { signal?: AbortSignal }) {
          seen.push(opts?.signal);
          return Object.assign(
            (async function* () {
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "x" } };
            })(),
            {
              abort: () => undefined,
              finalMessage: async () => ({
                usage: { input_tokens: 1, output_tokens: 1 },
                stop_reason: "end_turn",
                model: "m",
              }),
            },
          );
        },
        parse(_params: unknown, opts?: { signal?: AbortSignal }) {
          seen.push(opts?.signal);
          return Promise.resolve({
            stop_reason: "end_turn",
            parsed_output: { ok: true },
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
    } as unknown as Anthropic;
    const p = new AnthropicProvider({ id: "a", apiKey: "k", client, timeouts: fast });
    const ac = new AbortController();
    const withSignal = { ...req, signal: ac.signal };
    await drain(p.chat("claude", withSignal));
    await p.complete("claude", withSignal, schema);
    expect(seen).toHaveLength(2);
    for (const sig of seen) expect(sig?.aborted).toBe(false);
    ac.abort();
    for (const sig of seen) expect(sig?.aborted).toBe(true);
  });

  it("anthropic: a call that outlives the deadline is a retryable timeout; one the caller aborted is not", async () => {
    const hanging = {
      messages: {
        parse(_params: unknown, opts?: { signal?: AbortSignal }) {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(new Anthropic.APIUserAbortError());
            });
          });
        },
      },
    } as unknown as Anthropic;
    const p = new AnthropicProvider({
      id: "a",
      apiKey: "k",
      client: hanging,
      timeouts: { ...fast, totalMs: 40 },
    });
    const timedOut = await p.complete("claude", req, schema).catch((e: unknown) => e);
    expect(timedOut).toMatchObject({ code: "timeout", retryable: true });

    const ac = new AbortController();
    const pending = p.complete("claude", { ...req, signal: ac.signal }, schema).catch((e: unknown) => e);
    ac.abort();
    const aborted = await pending;
    expect(aborted).toBeInstanceOf(ProviderError);
    expect(aborted).not.toMatchObject({ code: "timeout" });
  });

  it("openai-compatible: a blocked address is not retried, and a caller abort mid-backoff is not either", async () => {
    let calls = 0;
    const blocked = Object.assign(new Error("blocked_address: private"), { name: "EgressBlockedError" });
    const fetchBlocked: typeof fetch = () => {
      calls++;
      return Promise.reject(new TypeError("fetch failed", { cause: blocked }));
    };
    const p = new OpenAICompatibleProvider({
      id: "oa",
      kind: "openai",
      apiKey: "k",
      fetch: fetchBlocked,
      timeouts: fast,
      sleep: noSleep,
    });
    const failure = await p.listModels().catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "network", retryable: true });
    expect(calls).toBe(1);

    let attempts = 0;
    const ac = new AbortController();
    const flaky: typeof fetch = () => {
      attempts++;
      ac.abort();
      return Promise.resolve(new Response("", { status: 503 }));
    };
    const q = new OpenAICompatibleProvider({
      id: "oa",
      kind: "openai",
      apiKey: "k",
      fetch: flaky,
      timeouts: fast,
      sleep: (_ms, signal) => (signal?.aborted ? Promise.reject(new Error("aborted")) : Promise.resolve()),
    });
    const stopped = await q.complete("m", { ...req, signal: ac.signal }, schema).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(ProviderError);
    expect(attempts).toBe(1);
  });
});

import type { ProviderConfig, Route, SttStreamEvent } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ModelCaller } from "../src/callModel.js";
import { BudgetExceededError, BudgetGuard, StaticBudgetLimits } from "../src/cost/budget.js";
import { InMemoryLedger } from "../src/cost/ledger.js";
import { PriceTable } from "../src/cost/pricing.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import {
  realtimeTranscriptionUrl,
  transcriptionSessionUpdate,
} from "../src/providers/openai-realtime-stt.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { RealtimeSocket, RealtimeSocketFactory } from "../src/providers/types.js";

/**
 * Streaming transcription (FR-30a, D-77) against a fake Realtime server: the socket factory is the
 * seam, so nothing here touches the network.
 */

type Listener = (...args: unknown[]) => void;

/** Plays the server half of the OpenAI Realtime transcription protocol, as documented. */
class FakeRealtimeServer {
  url = "";
  headers: Record<string, string> = {};
  sent: Record<string, unknown>[] = [];
  closed: { code?: number | undefined } | undefined;
  private listeners = new Map<string, Listener[]>();
  /** What the server does with the session.update: accept it, or answer with an error event. */
  constructor(private readonly behaviour: "accept" | "refuse" | "silent" = "accept") {}

  factory: RealtimeSocketFactory = (url, headers) => {
    this.url = url;
    this.headers = headers;
    const socket: RealtimeSocket = {
      send: (data) => {
        const msg = JSON.parse(data) as Record<string, unknown>;
        this.sent.push(msg);
        if (msg.type === "session.update") {
          queueMicrotask(() => {
            if (this.behaviour === "accept") this.emit({ type: "session.updated", session: msg.session });
            if (this.behaviour === "refuse")
              this.emit({
                type: "error",
                error: { type: "invalid_request_error", code: "invalid_api_key", message: "bad key" },
              });
          });
        }
      },
      close: (code) => {
        this.closed = { code };
        queueMicrotask(() => {
          this.fire("close", code ?? 1000, "");
        });
      },
      on: (event: string, listener: Listener) => {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
        return socket;
      },
    } as RealtimeSocket;
    queueMicrotask(() => {
      this.fire("open");
    });
    return socket;
  };

  emit(event: Record<string, unknown>): void {
    this.fire("message", Buffer.from(JSON.stringify(event)), false);
  }

  fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

function provider(server: FakeRealtimeServer, kind: "openai" | "openrouter" = "openai") {
  return new OpenAICompatibleProvider({
    id: "p1",
    kind,
    apiKey: "sk-test",
    socket: server.factory,
    fetch: () => Promise.reject(new Error("no network in tests")),
  });
}

async function take(events: AsyncIterable<SttStreamEvent>, n: number): Promise<SttStreamEvent[]> {
  const out: SttStreamEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
    if (out.length >= n) break;
  }
  return out;
}

describe("OpenAI realtime transcription adapter", () => {
  it("connects to the transcription intent with a bearer header and configures a 24 kHz session", async () => {
    const server = new FakeRealtimeServer();

    const session = await provider(server).transcribeStream("gpt-live-transcribe", {
      language: "fi",
      silenceMs: 650,
    });

    expect(server.url).toBe("wss://api.openai.com/v1/realtime?intent=transcription");
    expect(server.headers.authorization).toBe("Bearer sk-test");
    expect(server.headers["content-type"]).toBeUndefined();
    expect(server.sent[0]).toEqual({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: { model: "gpt-live-transcribe", languages: ["fi"] },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 650,
            },
          },
        },
      },
    });
    session.close();
  });

  it("sends the singular language hint to the older transcription models", () => {
    const update = transcriptionSessionUpdate("gpt-4o-mini-transcribe", { language: "en-GB" });
    const input = (update.session as { audio: { input: { transcription: unknown } } }).audio.input;

    // The API rejects a session carrying both, so exactly one is sent.
    expect(input.transcription).toEqual({ model: "gpt-4o-mini-transcribe", language: "en" });
  });

  it("derives a plain ws:// URL for a local OpenAI-compatible server", () => {
    expect(realtimeTranscriptionUrl("http://127.0.0.1:9000/v1/")).toBe(
      "ws://127.0.0.1:9000/v1/realtime?intent=transcription",
    );
  });

  it("appends audio as base64 PCM16", async () => {
    const server = new FakeRealtimeServer();
    const session = await provider(server).transcribeStream("gpt-live-transcribe", {});

    session.push(new Uint8Array([1, 2, 3, 4]));

    expect(server.sent.at(-1)).toEqual({
      type: "input_audio_buffer.append",
      audio: Buffer.from([1, 2, 3, 4]).toString("base64"),
    });
    session.close();
  });

  it("turns deltas into growing partial text and completion into a final transcript", async () => {
    const server = new FakeRealtimeServer();
    const session = await provider(server).transcribeStream("gpt-live-transcribe", {});

    server.emit({ type: "input_audio_buffer.speech_started", item_id: "i1", audio_start_ms: 10 });
    server.emit({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "i1",
      delta: "We type",
    });
    server.emit({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "i1",
      delta: " everything twice",
    });
    server.emit({ type: "input_audio_buffer.speech_stopped", item_id: "i1" });
    server.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "i1",
      transcript: "We type everything twice.",
      usage: { type: "duration", seconds: 2.4 },
    });

    const events = await take(session.events, 5);
    expect(events).toEqual([
      { type: "speech_started" },
      { type: "partial", itemId: "i1", text: "We type" },
      { type: "partial", itemId: "i1", text: "We type everything twice" },
      { type: "speech_stopped" },
      { type: "final", itemId: "i1", text: "We type everything twice.", durationSeconds: 2.4 },
    ]);
    session.close();
  });

  it("keeps partial text apart per item, since completions may arrive out of order", async () => {
    const server = new FakeRealtimeServer();
    const session = await provider(server).transcribeStream("gpt-live-transcribe", {});

    server.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "one" });
    server.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "b", delta: "two" });
    server.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: " more" });

    const events = await take(session.events, 3);
    expect(events.at(-1)).toEqual({ type: "partial", itemId: "a", text: "one more" });
    session.close();
  });

  it("rejects the open when the server refuses the session, rather than failing mid-call", async () => {
    const server = new FakeRealtimeServer("refuse");

    await expect(provider(server).transcribeStream("gpt-live-transcribe", {})).rejects.toMatchObject({
      name: "ProviderError",
      code: "auth",
    });
  });

  it("ends the stream with a fatal error when the socket drops mid-call", async () => {
    const server = new FakeRealtimeServer();
    const session = await provider(server).transcribeStream("gpt-live-transcribe", {});

    server.fire("close", 1006, "");

    const events = await take(session.events, 5);
    expect(events).toEqual([{ type: "error", message: "Transcription socket closed (1006)", fatal: true }]);
  });

  it("reports a failed utterance as recoverable", async () => {
    const server = new FakeRealtimeServer();
    const session = await provider(server).transcribeStream("gpt-live-transcribe", {});

    server.emit({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "x",
      error: { code: "audio_unintelligible", message: "The audio could not be transcribed." },
    });

    const [ev] = await take(session.events, 1);
    expect(ev).toEqual({ type: "error", message: "The audio could not be transcribed.", fatal: false });
    session.close();
  });

  it("is not offered by OpenRouter, which proxies chat models only", async () => {
    const server = new FakeRealtimeServer();
    const p = provider(server, "openrouter");

    expect(p.capabilities.streamingTranscription).toBe(false);
    await expect(p.transcribeStream("m", {})).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("ModelCaller.transcribeStream", () => {
  const cfg: ProviderConfig = {
    id: "p1",
    companyId: null,
    kind: "openai",
    name: "p1",
    apiKey: "sk-test",
    headers: {},
    enabled: true,
  };
  const route: Route = {
    companyId: null,
    purpose: "stt_stream",
    providerId: "p1",
    model: "gpt-live-transcribe",
    maxOutputTokens: 0,
    batchAllowed: false,
  };

  function setup(opts: { routed?: boolean; limitCents?: number; server?: FakeRealtimeServer } = {}) {
    const server = opts.server ?? new FakeRealtimeServer();
    const registry = new ProviderRegistry({ socket: server.factory });
    const ledger = new InMemoryLedger();
    const caller = new ModelCaller({
      routes: {
        resolve: async (_c, purpose) =>
          purpose === "stt_stream" && opts.routed !== false ? route : undefined,
      },
      providerConfigs: { get: async () => cfg },
      registry,
      prices: new PriceTable(),
      ledger,
      budget: new BudgetGuard(
        new StaticBudgetLimits(
          opts.limitCents === undefined
            ? []
            : [{ scope: "tenant", scopeId: "c1", limitCents: opts.limitCents, period: "month" }],
        ),
        ledger,
      ),
    });
    return { caller, ledger, server };
  }
  const ctx = { companyId: "c1", sessionId: "s1" };

  it("answers undefined with no stt_stream route, so the call falls back to per-utterance", async () => {
    const { caller } = setup({ routed: false });

    expect(await caller.transcribeStream(ctx, {})).toBeUndefined();
  });

  it("writes one ledger row per completed utterance", async () => {
    const { caller, ledger, server } = setup();
    const session = await caller.transcribeStream(ctx, {});
    if (!session) throw new Error("expected a session");

    server.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "i1",
      transcript: "Hello",
      usage: { type: "tokens", input_tokens: 13, output_tokens: 9, total_tokens: 22 },
    });
    await take(session.events, 1);

    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      purpose: "stt_stream",
      model: "gpt-live-transcribe",
      status: "ok",
      sessionId: "s1",
      usage: { inputTokens: 13, outputTokens: 9 },
    });
    session.close();
  });

  it("records an error row when the provider refuses the session, and rethrows", async () => {
    const { caller, ledger } = setup({ server: new FakeRealtimeServer("refuse") });

    await expect(caller.transcribeStream(ctx, {})).rejects.toMatchObject({ name: "ProviderError" });
    expect(ledger.entries.map((e) => e.status)).toEqual(["error"]);
  });

  it("refuses to open when the budget is spent", async () => {
    const { caller, ledger } = setup({ limitCents: 10 });
    // Already over: a session is priced by the minute afterwards, so the gate is spend so far.
    await ledger.record({
      companyId: "c1",
      purpose: "tts",
      providerId: "p1",
      model: "tts-1",
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      status: "ok",
      costCents: 25,
      createdAt: new Date(),
    });

    await expect(caller.transcribeStream(ctx, {})).rejects.toBeInstanceOf(BudgetExceededError);
    expect(ledger.entries.at(-1)).toMatchObject({ purpose: "stt_stream", status: "budget_exceeded" });
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  hasEngineFocus,
  interviewerTurn,
  promptText,
  renderTurn,
  structuredAnswer,
  tokens,
} from "./brain.js";
import { behaviourFromEnv, applyControl, type Behaviour } from "./config.js";
import type { ChatBody } from "./schema-gen.js";
import { acceptWebSocket, type Peer } from "./ws.js";

export interface Stats {
  /** Requests by route, counted when they arrive. */
  requests: Record<string, number>;
  /** What the failure injection did. */
  injected: { errors: number; rateLimited: number; hangs: number; cuts: number };
  inFlight: number;
  maxInFlight: number;
  realtimeConnections: number;
  realtimeAudioBytes: number;
}

export interface FakeProvider {
  server: Server;
  /** Base URL of the OpenAI-compatible API, ending in `/v1`. */
  url: string;
  port: number;
  behaviour: () => Behaviour;
  setBehaviour: (patch: Partial<Behaviour>) => void;
  stats: () => Stats;
  close: () => Promise<void>;
}

export interface FakeProviderOptions {
  behaviour?: Partial<Behaviour>;
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
}

const emptyStats = (): Stats => ({
  requests: {},
  injected: { errors: 0, rateLimited: 0, hangs: 0, cuts: 0 },
  inFlight: 0,
  maxInFlight: 0,
  realtimeConnections: 0,
  realtimeAudioBytes: 0,
});

/** mulberry32: a small seeded generator, so a run with the same seed fails the same requests. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPEECH_MIME: Record<string, string> = {
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

export async function startFakeProvider(opts: FakeProviderOptions = {}): Promise<FakeProvider> {
  const defaults = { ...behaviourFromEnv(opts.env ?? process.env), ...opts.behaviour };
  let behaviour: Behaviour = { ...defaults };
  let stats = emptyStats();
  let rnd = prng(behaviour.seed);
  const sink: { at: string; path: string; contentType: string; title: string | undefined; body: string }[] =
    [];

  const reseed = (): void => {
    rnd = prng(behaviour.seed);
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        resolve(Buffer.concat(chunks));
      });
      req.on("error", () => {
        resolve(Buffer.concat(chunks));
      });
    });

  /** Resolves after `ms`, or `false` at once when the client has gone. */
  const wait = (ms: number, res: ServerResponse): Promise<boolean> =>
    new Promise((resolve) => {
      if (res.destroyed) {
        resolve(false);
        return;
      }
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        res.off("close", onClose);
        resolve(ok);
      };
      const onClose = (): void => {
        done(false);
      };
      const timer = setTimeout(
        () => {
          done(true);
        },
        Math.max(0, ms),
      );
      res.once("close", onClose);
    });

  const latency = (): number => behaviour.latencyMs + rnd() * behaviour.jitterMs;

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  /** Failure injection for a request that reaches a model endpoint. True when the request was consumed. */
  const injectFailure = async (res: ServerResponse): Promise<boolean> => {
    if (rnd() < behaviour.hangRate) {
      stats.injected.hangs++;
      // The headers are never sent: the caller's own deadline is what ends this.
      if (behaviour.hangMs > 0) {
        await wait(behaviour.hangMs, res);
        res.destroy();
      }
      return true;
    }
    if (rnd() < behaviour.rate429) {
      stats.injected.rateLimited++;
      await wait(latency() / 4, res);
      json(
        res,
        429,
        { error: { message: "Rate limit reached (fake provider)", code: "rate_limit_exceeded" } },
        { "retry-after": "0" },
      );
      return true;
    }
    if (rnd() < behaviour.errorRate) {
      stats.injected.errors++;
      await wait(latency() / 4, res);
      json(res, behaviour.errorStatus, {
        error: {
          message: "The server had an error (fake provider)",
          code: "server_error",
          type: "server_error",
        },
      });
      return true;
    }
    return false;
  };

  const sse = (res: ServerResponse, data: unknown): void => {
    if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let body: ChatBody;
    try {
      body = JSON.parse(raw.toString("utf8")) as ChatBody;
    } catch {
      json(res, 400, { error: { message: "body is not JSON", code: "invalid_request_error" } });
      return;
    }
    if (await injectFailure(res)) return;
    const model = body.model ?? "fake-model";
    const inputTokens = tokens(promptText(body));
    if (!(await wait(latency(), res))) return;

    if (body.stream !== true) {
      const content = JSON.stringify(structuredAnswer(body));
      json(res, 200, {
        id: "chatcmpl-fake",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: inputTokens, completion_tokens: tokens(content) },
      });
      return;
    }

    const text = hasEngineFocus(body) ? renderTurn(interviewerTurn(body)) : "ok";
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sse(res, { id: "chatcmpl-fake", model, choices: [{ index: 0, delta: { role: "assistant" } }] });
    if (behaviour.firstTokenMs > 0 && !(await wait(behaviour.firstTokenMs, res))) return;

    const size = 14;
    const cut = rnd() < behaviour.cutRate ? Math.ceil(text.length / size / 2) : -1;
    let sent = 0;
    for (let at = 0; at < text.length; at += size) {
      if (cut >= 0 && sent >= cut) {
        stats.injected.cuts++;
        res.destroy();
        return;
      }
      sse(res, {
        id: "chatcmpl-fake",
        model,
        choices: [{ index: 0, delta: { content: text.slice(at, at + size) } }],
      });
      sent++;
      if (behaviour.charsPerSecond > 0 && !(await wait((size / behaviour.charsPerSecond) * 1000, res)))
        return;
    }
    sse(res, {
      id: "chatcmpl-fake",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: inputTokens, completion_tokens: tokens(text) },
    });
    if (!res.destroyed) res.write("data: [DONE]\n\n");
    res.end();
  }

  async function transcriptions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await readBody(req);
    if (await injectFailure(res)) return;
    if (!(await wait(latency(), res))) return;
    json(res, 200, { text: behaviour.transcript, duration: 2.5 });
  }

  async function speech(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    let format = "opus";
    try {
      format = (JSON.parse(raw.toString("utf8")) as { response_format?: string }).response_format ?? "opus";
    } catch {
      // The default format stands.
    }
    if (await injectFailure(res)) return;
    if (!(await wait(behaviour.ttsFirstByteMs + rnd() * behaviour.jitterMs, res))) return;
    res.writeHead(200, { "content-type": SPEECH_MIME[format] ?? "application/octet-stream" });
    const chunk = Math.max(1, Math.ceil(behaviour.ttsBytes / 6));
    for (let sent = 0; sent < behaviour.ttsBytes; sent += chunk) {
      res.write(Buffer.alloc(Math.min(chunk, behaviour.ttsBytes - sent), 0x5a));
      if (!(await wait(20, res))) return;
    }
    res.end();
  }

  async function embeddings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    if (behaviour.embeddings === "unsupported") {
      json(res, 404, {
        error: { message: "No endpoints found that support embeddings (fake provider)", code: 404 },
      });
      return;
    }
    if (await injectFailure(res)) return;
    let input: string[] = [];
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as { input?: string | string[] };
      input = Array.isArray(parsed.input) ? parsed.input : parsed.input ? [parsed.input] : [];
    } catch {
      // No input: an empty result.
    }
    if (!(await wait(latency(), res))) return;
    const vector = (text: string): number[] => {
      const next = prng(
        Array.from(text, (c) => c.charCodeAt(0)).reduce(
          (h, c) => Math.imul(h ^ c, 16777619) >>> 0,
          2166136261,
        ),
      );
      const v = Array.from({ length: 1536 }, () => next() - 0.5);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    };
    json(res, 200, {
      data: input.map((t, index) => ({ index, embedding: vector(t) })),
      usage: { prompt_tokens: input.reduce((n, t) => n + tokens(t), 0) },
    });
  }

  function models(res: ServerResponse): void {
    const price = { prompt: "0.0000005", completion: "0.0000015" };
    const ids = [
      "fake-fast",
      "fake-structured",
      "fake-strong",
      "fake-transcribe",
      "fake-speech",
      "fake-embed",
    ];
    json(res, 200, {
      object: "list",
      data: ids.map((id) => ({
        id,
        name: id,
        object: "model",
        context_length: 128_000,
        pricing: price,
        top_provider: { max_completion_tokens: 16_000 },
      })),
    });
  }

  /**
   * A webhook sink for the stack's alert path: the platform's and ops-notify's webhooks POST here,
   * and a drill reads what arrived with `GET /__sink`. Newest last, bounded.
   */
  function sinkRoute(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      if (req.method === "GET") {
        json(res, 200, { received: sink });
        return;
      }
      if (req.method === "DELETE") {
        sink.length = 0;
        json(res, 200, { received: sink });
        return;
      }
      const raw = (await readBody(req)).toString("utf8");
      sink.push({
        at: new Date().toISOString(),
        path: req.url ?? "",
        contentType: req.headers["content-type"] ?? "",
        title: typeof req.headers.title === "string" ? req.headers.title : undefined,
        body: raw.slice(0, 4000),
      });
      if (sink.length > 500) sink.shift();
      json(res, 200, { ok: true });
    })();
  }

  function control(req: IncomingMessage, res: ServerResponse, path: string): void {
    void (async () => {
      if (req.method === "POST" && path === "/__control/reset") {
        await readBody(req);
        behaviour = { ...defaults };
        stats = emptyStats();
        reseed();
        json(res, 200, { behaviour, stats });
        return;
      }
      if (req.method === "POST" && path === "/__control") {
        const raw = await readBody(req);
        try {
          const patch = JSON.parse(raw.toString("utf8") || "{}") as unknown;
          behaviour = applyControl(behaviour, patch);
          // Naming the seed restarts the sequence, even at the same value: that is how a run is repeated.
          if (patch && typeof patch === "object" && "seed" in patch) reseed();
        } catch {
          json(res, 400, { error: "control body must be JSON" });
          return;
        }
        json(res, 200, { behaviour, stats });
        return;
      }
      if (req.method === "POST" && path === "/__control/counters") {
        await readBody(req);
        stats = emptyStats();
        json(res, 200, { stats });
        return;
      }
      json(res, 200, { behaviour, stats });
    })();
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path === "/__health") {
      json(res, 200, { ok: true });
      return;
    }
    if (path === "/__sink" || path.startsWith("/__sink/")) {
      sinkRoute(req, res);
      return;
    }
    if (path.startsWith("/__control") || path === "/__stats") {
      control(req, res, path);
      return;
    }
    const route = path.replace(/^\/v1(?=\/)/, "");
    stats.requests[route] = (stats.requests[route] ?? 0) + 1;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    res.once("close", () => {
      stats.inFlight--;
    });
    const fail = (e: unknown): void => {
      if (!res.headersSent)
        json(res, 500, { error: { message: e instanceof Error ? e.message : "fake provider error" } });
      else res.destroy();
    };
    if (req.method === "GET" && route === "/models") {
      models(res);
      return;
    }
    if (req.method === "POST" && route === "/chat/completions") {
      chat(req, res).catch(fail);
      return;
    }
    if (req.method === "POST" && route === "/audio/transcriptions") {
      transcriptions(req, res).catch(fail);
      return;
    }
    if (req.method === "POST" && route === "/audio/speech") {
      speech(req, res).catch(fail);
      return;
    }
    if (req.method === "POST" && route === "/embeddings") {
      embeddings(req, res).catch(fail);
      return;
    }
    json(res, 404, { error: { message: `no route ${req.method} ${path}`, code: "not_found" } });
  });

  server.on("upgrade", (req, socket) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path !== "/v1/realtime" && path !== "/realtime") {
      socket.destroy();
      return;
    }
    stats.realtimeConnections++;
    acceptWebSocket(req, socket, (peer) => realtimeSession(peer));
  });

  /** One realtime transcription session: configure, then one scripted utterance per burst of audio. */
  function realtimeSession(peer: Peer): { onMessage: (t: string) => void; onClose: () => void } {
    let item = 0;
    let utteranceBytes = 0;
    let started = false;
    const timers = new Set<NodeJS.Timeout>();
    const emit = (event: Record<string, unknown>): void => {
      if (!peer.closed) peer.send(JSON.stringify(event));
    };
    // 24 kHz, 16-bit mono: 48 bytes per millisecond.
    const need = () => behaviour.sttUtteranceMs * 48;
    return {
      onMessage(text) {
        let msg: { type?: string; audio?: string; session?: unknown };
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "session.update") {
          if (behaviour.realtime === "refuse") {
            emit({
              type: "error",
              error: { type: "invalid_request_error", code: "model_not_found", message: "no such model" },
            });
            return;
          }
          emit({ type: "session.updated", session: msg.session });
          return;
        }
        if (msg.type !== "input_audio_buffer.append") return;
        const bytes = Buffer.from(msg.audio ?? "", "base64").byteLength;
        stats.realtimeAudioBytes += bytes;
        if (behaviour.realtime === "drop") {
          peer.close(1011, "server error");
          return;
        }
        utteranceBytes += bytes;
        const id = `item_${item + 1}`;
        if (!started) {
          started = true;
          emit({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 0 });
        }
        if (utteranceBytes < need()) return;
        // Enough audio for one utterance: words, VAD stop, the final transcript.
        const words = behaviour.transcript.split(" ");
        const half = Math.ceil(words.length / 2);
        const spokenMs = Math.round(utteranceBytes / 48);
        utteranceBytes = 0;
        started = false;
        item++;
        const timer = setTimeout(() => {
          timers.delete(timer);
          emit({
            type: "conversation.item.input_audio_transcription.delta",
            item_id: id,
            delta: words.slice(0, half).join(" "),
          });
          emit({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: spokenMs });
          emit({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: id,
            transcript: behaviour.transcript,
            usage: { type: "duration", seconds: spokenMs / 1000 },
          });
        }, behaviour.latencyMs / 4);
        timers.add(timer);
      },
      onClose() {
        for (const t of timers) clearTimeout(t);
        timers.clear();
      },
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const host = opts.host === undefined || opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host;
  return {
    server,
    url: `http://${host}:${port}/v1`,
    port,
    behaviour: () => behaviour,
    setBehaviour: (patch) => {
      behaviour = { ...behaviour, ...patch };
      if (patch.seed !== undefined) reseed();
    },
    stats: () => stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

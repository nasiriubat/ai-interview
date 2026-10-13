import {
  emptyUsage,
  type Capabilities,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type ModelInfo,
  type ProviderKind,
  type SpeechInput,
  type SpeechOutput,
  type StopReason,
  type SttStreamInput,
  type SttStreamSession,
  type Transcript,
  type TranscriptionInput,
  type Usage,
} from "@aidp/shared";
import { z } from "zod";
import { openRealtimeTranscription } from "./openai-realtime-stt.js";
import { wsSocketFactory } from "./realtime-socket.js";
import {
  backoffMs,
  guardStream,
  isTimeoutAbort,
  retryAfterMs,
  sleep,
  timeoutError,
  timeoutsFromEnv,
  type ProviderTimeouts,
} from "./resilience.js";
import {
  ProviderError,
  redactedBody,
  upstreamMessage,
  type Provider,
  type RealtimeSocketFactory,
} from "./types.js";

/** What the browser must be told the audio is, per requested format. */
const SPEECH_MIME: Record<NonNullable<SpeechInput["format"]>, string> = {
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "audio/pcm",
};

/** A web ReadableStream as an async iterable, which Node streams already are and this is not. */
async function* streamBytes(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    // Barge-in aborts mid-stream; without this the connection is left half-read and the provider
    // keeps synthesizing audio nobody will hear.
    reader.releaseLock();
  }
}

export type OpenAICompatibleKind = Exclude<ProviderKind, "anthropic" | "local">;

export interface OpenAICompatibleOptions {
  id: string;
  kind: OpenAICompatibleKind;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Test seam. */
  fetch?: typeof fetch;
  /** Test seam for the streaming transcription socket; defaults to `ws`. */
  socket?: RealtimeSocketFactory;
  /** Deadlines and retries (D-93); the process environment's `PROVIDER_*` values when absent. */
  timeouts?: ProviderTimeouts;
  /** Test seam: what waits between retries, so a test does not really sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_BASE_URLS: Partial<Record<OpenAICompatibleKind, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/**
 * One adapter for OpenAI, OpenRouter, a LiteLLM proxy, and any other server that speaks
 * the Chat Completions protocol (Ollama, vLLM, ...). Prices are read from the
 * provider's model list when it publishes them (OpenRouter, LiteLLM).
 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly kind: OpenAICompatibleKind;
  readonly capabilities: Capabilities;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string;
  private readonly socketFactory: RealtimeSocketFactory;
  private readonly timeouts: ProviderTimeouts;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * What each model has been seen to accept, by model id. `strictSchema` is whether a strict
   * `json_schema` response format is taken; `reasoningOff` whether the `reasoning` control is.
   * Learned from the first refusal and kept for the life of the adapter (the registry caches
   * adapters per provider config), so a route that cannot take either pays the rejected round trip
   * once, not on every structured call (live run 2026-10-14, bug 7).
   */
  private readonly accepts = new Map<string, { strictSchema?: boolean; reasoningOff?: boolean }>();

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.kind = opts.kind;
    const base = opts.baseUrl ?? DEFAULT_BASE_URLS[opts.kind];
    if (!base)
      throw new ProviderError(`Provider kind '${opts.kind}' requires a base URL`, "bad_request", false);
    this.apiKey = opts.apiKey;
    this.baseUrl = base.replace(/\/+$/, "");
    this.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      ...(opts.kind === "openrouter" ? { "x-title": "AI Discovery Platform" } : {}),
      ...(opts.headers ?? {}),
    };
    this.fetchImpl = opts.fetch ?? fetch;
    this.socketFactory = opts.socket ?? wsSocketFactory;
    this.timeouts = opts.timeouts ?? timeoutsFromEnv();
    this.sleepFn = opts.sleep ?? sleep;
    this.capabilities = {
      caching: false, // OpenAI-style providers cache automatically; there is no marker to set
      structuredOutput: true, // json_schema response_format, with a JSON-mode fallback
      effort: false,
      batch: false,
      vision: true,
      transcription: opts.kind !== "openrouter",
      // Same story as transcription: OpenRouter proxies chat models only.
      speech: opts.kind !== "openrouter",
      // The Realtime transcription socket. OpenAI speaks it; an OpenAI-compatible server may or may
      // not, and a route pointing at one that does not fails at the start of a call, where the
      // live session drops to per-utterance transcription instead (D-77).
      streamingTranscription: opts.kind !== "openrouter",
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.kind === "litellm") {
      const info = await this.tryJson("/model/info");
      if (info && Array.isArray(info.data))
        return info.data.map(fromLiteLLMModel).filter(Boolean) as ModelInfo[];
    }
    const res = await this.request("/models", { method: "GET" });
    const body = (await res.json()) as { data?: unknown[] };
    return (body.data ?? []).map(fromOpenAIModel);
  }

  /**
   * The body fields that switch hidden reasoning off, when the request asks for it and the route is
   * one that has the control. OpenRouter only: its `reasoning` object is the documented switch for
   * reasoning-capable models, and a plain OpenAI-compatible server may reject an unknown field.
   */
  private reasoningFields(model: string, req: ChatRequest): Record<string, unknown> {
    if (req.reasoning !== "off" || this.kind !== "openrouter") return {};
    if (this.accepts.get(model)?.reasoningOff === false) return {};
    return { reasoning: { effort: "none" } };
  }

  private rememberNoReasoning(model: string): void {
    this.accepts.set(model, { ...this.accepts.get(model), reasoningOff: false });
  }

  async *chat(model: string, req: ChatRequest): AsyncIterable<ChatEvent> {
    const bodyFor = (reasoning: Record<string, unknown>) => ({
      model,
      messages: toOpenAIMessages(req),
      max_tokens: req.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...reasoning,
    });
    // The first-token clock starts at the request, not at the first byte of the response: a
    // gateway that holds the headers until it has output would otherwise get a fresh deadline.
    const began = Date.now();
    const controller = new AbortController();
    const send = (reasoning: Record<string, unknown>) =>
      this.request("/chat/completions", {
        method: "POST",
        body: JSON.stringify(bodyFor(reasoning)),
        ...(req.signal ? { signal: req.signal } : {}),
        controller,
      });
    const reasoning = this.reasoningFields(model, req);
    let res: Response;
    try {
      res = await send(reasoning);
    } catch (e) {
      // A route that does not know the reasoning control refuses the request before any work:
      // remember that and ask again without it.
      if (
        Object.keys(reasoning).length > 0 &&
        e instanceof ProviderError &&
        (e.code === "bad_request" || e.code === "not_found")
      ) {
        this.rememberNoReasoning(model);
        res = await send({});
      } else throw e;
    }
    if (!res.body) throw new ProviderError("Empty stream body", "server", true);
    let usage = emptyUsage();
    let stop: StopReason = "other";
    let seenModel = model;
    const chunks = guardStream(parseSse(res.body), {
      firstMs: this.timeouts.firstTokenMs,
      idleMs: this.timeouts.idleMs,
      since: began,
      isOutput: startsOutput,
      abort: () => {
        controller.abort();
      },
      label: "Model stream",
    });
    try {
      for await (const chunk of chunks) {
        const c = chunk as OpenAIChunk;
        if (c.model) seenModel = c.model;
        const choice = c.choices?.[0];
        const text = choice?.delta?.content;
        if (text) yield { type: "text", text };
        if (choice?.finish_reason) stop = toStopReason(choice.finish_reason);
        if (c.usage) usage = toUsage(c.usage);
      }
    } catch (e) {
      throw this.streamError(e);
    }
    yield { type: "done", usage, stopReason: stop, model: seenModel };
  }

  async complete<T>(
    model: string,
    req: ChatRequest,
    schema: z.ZodType<T>,
    schemaName = "result",
  ): Promise<{ value: T; usage: Usage }> {
    const jsonSchema = z.toJSONSchema(schema, { target: "openapi-3.0", unrepresentable: "any" });
    // The schema always travels in the prompt too: some routers accept `json_schema` and then
    // hand the request to a provider that ignores it (seen with OpenRouter), so the model must
    // know the shape either way. The result is validated locally regardless.
    const instruction = `Respond with a single JSON value only, no prose and no code fences, matching this JSON schema exactly:\n${JSON.stringify(jsonSchema)}`;
    const messages = [{ role: "system", content: instruction }, ...toOpenAIMessages(req)];
    const reasoningFields = this.reasoningFields(model, req);
    const base = (withReasoning: boolean) => ({
      model,
      messages,
      max_tokens: req.maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      // OpenRouter: only route to providers that honor every parameter we send (response_format).
      ...(this.kind === "openrouter" ? { provider: { require_parameters: true } } : {}),
      ...(withReasoning ? reasoningFields : {}),
    });
    const report = (a: {
      usage: Usage;
      ok: boolean;
      note?: "rejected" | "invalid" | "truncated";
      started: number;
    }): void => {
      req.onAttempt?.({
        usage: a.usage,
        ok: a.ok,
        ...(a.note ? { note: a.note } : {}),
        latencyMs: Math.max(0, Date.now() - a.started),
      });
    };
    const attempt = async (
      responseFormat: Record<string, unknown>,
      allowStatuses: number[],
    ): Promise<{ status: number; body?: OpenAICompletion; started: number }> => {
      const started = Date.now();
      const send = (withReasoning: boolean) =>
        this.request("/chat/completions", {
          method: "POST",
          body: JSON.stringify({ ...base(withReasoning), response_format: responseFormat }),
          allowStatuses,
          ...(req.signal ? { signal: req.signal } : {}),
        });
      let res: Response;
      try {
        res = await send(Object.keys(reasoningFields).length > 0);
      } catch (e) {
        report({ usage: emptyUsage(), ok: false, note: "rejected", started });
        if (
          Object.keys(reasoningFields).length > 0 &&
          this.accepts.get(model)?.reasoningOff !== false &&
          e instanceof ProviderError &&
          (e.code === "bad_request" || e.code === "not_found")
        ) {
          // Refused before any work, so nothing was billed; ask again without the control.
          this.rememberNoReasoning(model);
          return attempt(responseFormat, allowStatuses);
        }
        throw e;
      }
      if (allowStatuses.includes(res.status) && Object.keys(reasoningFields).length > 0) {
        // A 400 may be the strict schema or the reasoning control. Ask again without the control:
        // if that is accepted the control was the cause and is remembered as unsupported; if the
        // same status comes back the schema was, and the control stays untested.
        report({ usage: emptyUsage(), ok: false, note: "rejected", started });
        const retried = await this.request("/chat/completions", {
          method: "POST",
          body: JSON.stringify({ ...base(false), response_format: responseFormat }),
          allowStatuses,
          ...(req.signal ? { signal: req.signal } : {}),
        });
        if (!allowStatuses.includes(retried.status)) this.rememberNoReasoning(model);
        const again = Date.now();
        if (allowStatuses.includes(retried.status)) return { status: retried.status, started: again };
        return { status: retried.status, body: (await retried.json()) as OpenAICompletion, started: again };
      }
      if (allowStatuses.includes(res.status)) return { status: res.status, started };
      return { status: res.status, body: (await res.json()) as OpenAICompletion, started };
    };
    const parse = (body: OpenAICompletion): { ok: true; value: T } | { ok: false; error: ProviderError } => {
      const choice = body.choices?.[0];
      const finish = choice?.finish_reason;
      if (finish === "content_filter")
        return { ok: false, error: new ProviderError("Model refused the request", "refusal", false) };
      const raw = choice?.message?.content ?? "";
      const json = extractJsonValue(raw);
      if (json === undefined) {
        const why = finish === "length" ? "output was cut off by max_tokens" : "no JSON value in the output";
        return {
          ok: false,
          error: new ProviderError(`Structured output was not valid JSON: ${why}`, "parse", true),
        };
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(json);
      } catch (e) {
        return {
          ok: false,
          error: new ProviderError("Structured output was not valid JSON", "parse", true, e),
        };
      }
      const parsed = schema.safeParse(parsedJson);
      if (!parsed.success)
        return {
          ok: false,
          error: new ProviderError(
            `Structured output failed validation: ${parsed.error.message}`,
            "parse",
            true,
            parsed.error,
          ),
        };
      return { ok: true, value: parsed.data };
    };
    const usageOf = (body: OpenAICompletion): Usage => (body.usage ? toUsage(body.usage) : emptyUsage());
    const noteFor = (body: OpenAICompletion): "invalid" | "truncated" =>
      body.choices?.[0]?.finish_reason === "length" ? "truncated" : "invalid";

    // First attempt: strict json_schema, unless this model has been seen to refuse it. Anthropic
    // models behind a gateway are known not to take it (live run: a guaranteed 400 on every call).
    const known = this.accepts.get(model)?.strictSchema;
    const tryStrict = known ?? !/^anthropic\//i.test(model);
    let firstError: ProviderError | undefined;
    if (tryStrict) {
      const first = await attempt(
        { type: "json_schema", json_schema: { name: schemaName, schema: jsonSchema, strict: true } },
        [400, 422],
      );
      if (first.body) {
        this.accepts.set(model, { ...this.accepts.get(model), strictSchema: true });
        const r = parse(first.body);
        if (r.ok) {
          report({ usage: usageOf(first.body), ok: true, started: first.started });
          return { value: r.value, usage: usageOf(first.body) };
        }
        report({ usage: usageOf(first.body), ok: false, note: noteFor(first.body), started: first.started });
        if (r.error.code === "refusal") throw r.error;
        firstError = r.error;
      } else {
        // 400 or 422: the route does not take strict json_schema. Nothing was billed.
        this.accepts.set(model, { ...this.accepts.get(model), strictSchema: false });
        report({ usage: emptyUsage(), ok: false, note: "rejected", started: first.started });
      }
    }
    // JSON mode with the schema in the prompt (also when the strict answer did not validate).
    const second = await attempt({ type: "json_object" }, []);
    if (!second.body) throw firstError ?? new ProviderError("Structured output failed", "parse", true);
    const r = parse(second.body);
    if (!r.ok) {
      report({ usage: usageOf(second.body), ok: false, note: noteFor(second.body), started: second.started });
      throw r.error;
    }
    report({ usage: usageOf(second.body), ok: true, started: second.started });
    return { value: r.value, usage: usageOf(second.body) };
  }

  async transcribe(
    model: string,
    input: TranscriptionInput,
  ): Promise<{ transcript: Transcript; usage: Usage }> {
    if (!this.capabilities.transcription)
      throw new ProviderError("Provider does not transcribe audio", "unsupported", false);
    const form = new FormData();
    form.append("model", model);
    form.append("file", new Blob([input.data.slice().buffer], { type: input.mime }), input.filename);
    if (input.language) form.append("language", input.language);
    form.append("response_format", "verbose_json");
    const headers = { ...this.headers };
    delete headers["content-type"]; // let fetch set the multipart boundary
    const res = await this.request("/audio/transcriptions", { method: "POST", body: form, headers });
    const body = (await res.json()) as { text?: string; duration?: number };
    return {
      transcript: {
        text: body.text ?? "",
        ...(body.duration !== undefined ? { durationSeconds: body.duration } : {}),
      },
      usage: emptyUsage(), // transcription is priced per minute; the ledger prices it from durationSeconds
    };
  }

  /**
   * `/audio/speech`, streamed straight through (FR-30a).
   *
   * The response body is handed on as an async iterable rather than buffered, so the first chunk
   * can reach the participant's speakers while the provider is still synthesizing the rest. That
   * is the difference between meeting the 1.5-second target and missing it by a multiple.
   *
   * Priced per character rather than per token, so the ledger gets an empty `Usage` here and the
   * caller records the character count; see ModelCaller.speak.
   */
  async speak(model: string, input: SpeechInput, signal?: AbortSignal): Promise<SpeechOutput> {
    if (!this.capabilities.speech)
      throw new ProviderError("Provider does not synthesize speech", "unsupported", false);
    const format = input.format ?? "opus";
    const res = await this.request("/audio/speech", {
      method: "POST",
      body: JSON.stringify({
        model,
        input: input.text,
        voice: input.voice ?? "alloy",
        response_format: format,
        ...(input.speed === undefined ? {} : { speed: input.speed }),
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.body) throw new ProviderError("Speech response had no body", "parse", true);
    return { audio: streamBytes(res.body), mime: SPEECH_MIME[format] };
  }

  /**
   * Streaming transcription over the Realtime API (FR-30a, D-77); see `openai-realtime-stt.ts` for
   * the protocol as documented. Priced per minute of audio, so, like `transcribe`, the ledger gets
   * whatever usage the provider reports on each completed utterance.
   */
  async transcribeStream(model: string, input: SttStreamInput): Promise<SttStreamSession> {
    if (!this.capabilities.streamingTranscription)
      throw new ProviderError("Provider does not stream transcription", "unsupported", false);
    return openRealtimeTranscription(
      { baseUrl: this.baseUrl, headers: this.headers, socket: this.socketFactory },
      model,
      input,
    );
  }

  async embed(model: string, texts: string[]): Promise<{ vectors: number[][]; usage: Usage }> {
    if (texts.length === 0) return { vectors: [], usage: emptyUsage() };
    const res = await this.request("/embeddings", {
      method: "POST",
      body: JSON.stringify({ model, input: texts }),
    });
    const body = (await res.json()) as {
      data?: { index?: number; embedding?: number[] }[];
      usage?: { prompt_tokens?: number };
    };
    const vectors: number[][] = new Array<number[]>(texts.length).fill([]);
    for (const [i, d] of (body.data ?? []).entries()) vectors[d.index ?? i] = d.embedding ?? [];
    if (vectors.some((v) => v.length === 0))
      throw new ProviderError("Embedding response was incomplete", "parse", true);
    return {
      vectors,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
    };
  }

  private async tryJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.request(path, { method: "GET", allowStatuses: [404] });
      if (res.status === 404) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * One HTTP call with a deadline and a bounded number of retries (D-93).
   *
   * Every attempt carries `AbortSignal.timeout(totalMs)`, which also covers reading the body, so a
   * provider that answers the headers and then stalls is cut off like one that never answered.
   * A network error, a timeout, a 429 or a 5xx is tried again up to `maxRetries` times with
   * jittered backoff, honouring a short `Retry-After`; anything else (a bad key, a bad request) is
   * the same on the next attempt and is not retried. Nothing is retried once the caller's own
   * signal has aborted: that is a participant who started talking, not a provider that failed.
   *
   * Until this, `speak` handed its barge-in signal to this method and the method dropped it, so an
   * interrupted synthesis kept streaming (and billing) to nobody.
   */
  private async request(
    path: string,
    init: {
      method: string;
      body?: BodyInit;
      headers?: Record<string, string>;
      allowStatuses?: number[];
      signal?: AbortSignal;
      /** Lets a stream guard cancel the connection it is watching. */
      controller?: AbortController;
    },
  ): Promise<Response> {
    const { totalMs, maxRetries } = this.timeouts;
    for (let attempt = 1; ; attempt++) {
      const signals = [AbortSignal.timeout(totalMs)];
      if (init.signal) signals.push(init.signal);
      if (init.controller) signals.push(init.controller.signal);
      const signal = AbortSignal.any(signals);
      const retriesLeft = attempt <= maxRetries;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method,
          headers: init.headers ?? this.headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
          signal,
        });
      } catch (e) {
        if (init.signal?.aborted)
          throw new ProviderError(`Network error calling ${path}`, "network", true, e);
        // A call that has already used its whole ceiling is not run again inside this request:
        // that would turn a two-minute limit into six, in the middle of an interview turn. The
        // error is retryable, so the layer that owns retries (the job queue, the participant's
        // "try again") decides, with the time it actually has.
        if (isTimeoutAbort(e)) throw timeoutError(`Call to ${path}`, totalMs, e);
        const failure = new ProviderError(`Network error calling ${path}`, "network", true, e);
        // An address the egress policy refuses is refused again on the next attempt.
        if (isEgressBlock(e) || !retriesLeft) throw failure;
        await this.pause(backoffMs(attempt), init.signal);
        continue;
      }
      if (res.ok || init.allowStatuses?.includes(res.status)) return res;
      const text = await res.text().catch(() => "");
      // The message names the status and, at most, a short identifier the upstream chose. The body
      // goes on `cause` only, redacted, for the server log (see upstreamMessage).
      const msg = upstreamMessage(res.status, upstreamCode(text));
      const detail = { status: res.status, path, body: redactedBody(text, [this.apiKey]) };
      if (res.status === 401 || res.status === 403) throw new ProviderError(msg, "auth", false, detail);
      if (res.status === 404) throw new ProviderError(msg, "not_found", false, detail);
      if (res.status !== 429 && res.status < 500) throw new ProviderError(msg, "bad_request", false, detail);
      if (!retriesLeft)
        throw new ProviderError(msg, res.status === 429 ? "rate_limit" : "server", true, detail);
      await this.pause(retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt), init.signal);
    }
  }

  /** What a stream that died mid-way is reported as: the guard's own timeout, or a dropped connection. */
  private streamError(e: unknown): ProviderError {
    if (e instanceof ProviderError) return e;
    if (isTimeoutAbort(e)) return timeoutError("Model stream", this.timeouts.totalMs, e);
    return new ProviderError("The model stream was interrupted", "network", true, e);
  }

  /** The wait between attempts; the caller's signal ends it, so a barge-in is not held up by a backoff. */
  private async pause(ms: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.sleepFn(ms, signal);
    } catch (e) {
      throw new ProviderError("Request aborted while waiting to retry", "network", true, e);
    }
  }
}

/**
 * Whether a fetch failure is the server's egress policy refusing the address (packages/core/src/net).
 * By name, because this package cannot import the policy; the error may sit under `cause`.
 */
function isEgressBlock(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur instanceof Error && depth < 4; depth++) {
    if (cur.name === "EgressBlockedError") return true;
    cur = cur.cause;
  }
  return false;
}

/** The upstream's own error identifier (`error.code`, else `error.type`), if the body is the usual JSON. */
function upstreamCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
    const code = parsed.error?.code ?? parsed.error?.type;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

// ---------- wire types (only the fields we read) ----------
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}
interface OpenAIChunk {
  model?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: OpenAIUsage | null;
}
/**
 * Whether a streamed chunk is the provider producing something: any delta field beyond the role
 * (content, reasoning, tool use) or a finish reason. The opening `{"role":"assistant"}` chunk
 * arrives at once even from a model that then thinks for a minute, so it does not count.
 */
function startsOutput(chunk: unknown): boolean {
  const choice = (chunk as OpenAIChunk).choices?.[0];
  if (!choice) return false;
  if (choice.finish_reason) return true;
  const delta = choice.delta as Record<string, unknown> | undefined;
  return Object.entries(delta ?? {}).some(([k, v]) => k !== "role" && v !== null && v !== "");
}

interface OpenAICompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: OpenAIUsage | null;
}

function toOpenAIMessages(req: ChatRequest): { role: string; content: unknown }[] {
  const out: { role: string; content: unknown }[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) out.push({ role: m.role, content: toOpenAIContent(m) });
  return out;
}

function toOpenAIContent(m: ChatMessage): unknown {
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.base64}` } },
  );
}

function toUsage(u: OpenAIUsage): Usage {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: u.completion_tokens ?? 0,
  };
}

function toStopReason(r: string): StopReason {
  if (r === "stop") return "end_turn";
  if (r === "length") return "max_tokens";
  if (r === "content_filter") return "refusal";
  return "other";
}

/** The first balanced JSON object or array in a string, tolerating code fences and surrounding prose. */
export function extractJsonValue(s: string): string | undefined {
  const start = s.search(/[[{]/);
  if (start < 0) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return undefined;
      if (stack.length === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

/** OpenRouter publishes pricing as USD per token (strings). Convert to per million. */
function fromOpenAIModel(raw: unknown): ModelInfo {
  const m = raw as {
    id: string;
    name?: string;
    context_length?: number;
    pricing?: { prompt?: string | number; completion?: string | number; input_cache_read?: string | number };
  };
  const perMtok = (v: string | number | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined;
  };
  const info: ModelInfo = { id: m.id, name: m.name ?? m.id };
  if (m.context_length) info.contextWindow = m.context_length;
  const inp = perMtok(m.pricing?.prompt);
  const out = perMtok(m.pricing?.completion);
  const cached = perMtok(m.pricing?.input_cache_read);
  if (inp !== undefined) info.inputPerMtok = inp;
  if (out !== undefined) info.outputPerMtok = out;
  if (cached !== undefined) info.cachedInputPerMtok = cached;
  return info;
}

/** LiteLLM /model/info entries carry per-token costs in model_info. */
function fromLiteLLMModel(raw: unknown): ModelInfo | null {
  const m = raw as {
    model_name?: string;
    model_info?: {
      input_cost_per_token?: number;
      output_cost_per_token?: number;
      cache_read_input_token_cost?: number;
      max_input_tokens?: number;
    };
  };
  if (!m.model_name) return null;
  const info: ModelInfo = { id: m.model_name, name: m.model_name };
  const mi = m.model_info ?? {};
  if (mi.max_input_tokens) info.contextWindow = mi.max_input_tokens;
  if (mi.input_cost_per_token !== undefined) info.inputPerMtok = mi.input_cost_per_token * 1_000_000;
  if (mi.output_cost_per_token !== undefined) info.outputPerMtok = mi.output_cost_per_token * 1_000_000;
  if (mi.cache_read_input_token_cost !== undefined)
    info.cachedInputPerMtok = mi.cache_read_input_token_cost * 1_000_000;
  return info;
}

/** Minimal SSE parser: yields the JSON payload of each `data:` line, stops at [DONE]. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        if (!data) continue;
        try {
          yield JSON.parse(data);
        } catch {
          // tolerate keep-alive or malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

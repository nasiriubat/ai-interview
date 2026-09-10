import {
  emptyUsage,
  type Capabilities,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type ModelInfo,
  type ProviderKind,
  type StopReason,
  type Transcript,
  type TranscriptionInput,
  type Usage,
} from "@aidp/shared";
import { z } from "zod";
import { ProviderError, type Provider } from "./types.js";

export type OpenAICompatibleKind = Exclude<ProviderKind, "anthropic">;

export interface OpenAICompatibleOptions {
  id: string;
  kind: OpenAICompatibleKind;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Test seam. */
  fetch?: typeof fetch;
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

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.kind = opts.kind;
    const base = opts.baseUrl ?? DEFAULT_BASE_URLS[opts.kind];
    if (!base)
      throw new ProviderError(`Provider kind '${opts.kind}' requires a base URL`, "bad_request", false);
    this.baseUrl = base.replace(/\/+$/, "");
    this.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      ...(opts.kind === "openrouter" ? { "x-title": "AI Discovery Platform" } : {}),
      ...(opts.headers ?? {}),
    };
    this.fetchImpl = opts.fetch ?? fetch;
    this.capabilities = {
      caching: false, // OpenAI-style providers cache automatically; there is no marker to set
      structuredOutput: true, // json_schema response_format, with a JSON-mode fallback
      effort: false,
      batch: false,
      vision: true,
      transcription: opts.kind !== "openrouter",
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

  async *chat(model: string, req: ChatRequest): AsyncIterable<ChatEvent> {
    const body = {
      model,
      messages: toOpenAIMessages(req),
      max_tokens: req.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    const res = await this.request("/chat/completions", { method: "POST", body: JSON.stringify(body) });
    if (!res.body) throw new ProviderError("Empty stream body", "server", true);
    let usage = emptyUsage();
    let stop: StopReason = "other";
    let seenModel = model;
    for await (const chunk of parseSse(res.body)) {
      const c = chunk as OpenAIChunk;
      if (c.model) seenModel = c.model;
      const choice = c.choices?.[0];
      const text = choice?.delta?.content;
      if (text) yield { type: "text", text };
      if (choice?.finish_reason) stop = toStopReason(choice.finish_reason);
      if (c.usage) usage = toUsage(c.usage);
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
    const base = {
      model,
      messages: toOpenAIMessages(req),
      max_tokens: req.maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    // First attempt: strict json_schema. Many OpenAI-compatible servers accept it.
    let res = await this.request("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        ...base,
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, schema: jsonSchema, strict: true },
        },
      }),
      allowStatuses: [400, 422],
    });
    if (res.status === 400 || res.status === 422) {
      // Fallback: JSON mode plus the schema in the prompt; validate locally.
      const msgs = toOpenAIMessages(req);
      const instruction = `Respond with a single JSON object only, matching this JSON schema exactly:\n${JSON.stringify(jsonSchema)}`;
      const withSchema = [{ role: "system", content: instruction }, ...msgs];
      res = await this.request("/chat/completions", {
        method: "POST",
        body: JSON.stringify({ ...base, messages: withSchema, response_format: { type: "json_object" } }),
      });
    }
    const body = (await res.json()) as OpenAICompletion;
    const choice = body.choices?.[0];
    const finish = choice?.finish_reason;
    if (finish === "content_filter") throw new ProviderError("Model refused the request", "refusal", false);
    const raw = choice?.message?.content ?? "";
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripFences(raw));
    } catch (e) {
      throw new ProviderError("Structured output was not valid JSON", "parse", true, e);
    }
    const parsed = schema.safeParse(parsedJson);
    if (!parsed.success)
      throw new ProviderError(
        `Structured output failed validation: ${parsed.error.message}`,
        "parse",
        true,
        parsed.error,
      );
    return { value: parsed.data, usage: body.usage ? toUsage(body.usage) : emptyUsage() };
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

  private async request(
    path: string,
    init: { method: string; body?: BodyInit; headers?: Record<string, string>; allowStatuses?: number[] },
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: init.headers ?? this.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (e) {
      throw new ProviderError(`Network error calling ${path}`, "network", true, e);
    }
    if (res.ok || init.allowStatuses?.includes(res.status)) return res;
    const text = await res.text().catch(() => "");
    const msg = `${res.status} from ${path}: ${text.slice(0, 500)}`;
    if (res.status === 401 || res.status === 403) throw new ProviderError(msg, "auth", false);
    if (res.status === 404) throw new ProviderError(msg, "not_found", false);
    if (res.status === 429) throw new ProviderError(msg, "rate_limit", true);
    if (res.status >= 500) throw new ProviderError(msg, "server", true);
    throw new ProviderError(msg, "bad_request", false);
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

function stripFences(s: string): string {
  const t = s.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m?.[1] ?? t;
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

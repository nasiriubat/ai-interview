import type {
  Capabilities,
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ModelInfo,
  StopReason,
  Usage,
} from "@aidp/shared";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { ProviderError, type Provider } from "./types.js";

export interface AnthropicProviderOptions {
  id: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Test seam: inject a preconfigured client. */
  client?: Anthropic;
}

/** Anthropic direct, through the official SDK. Caching, structured output and effort are exposed. */
export class AnthropicProvider implements Provider {
  readonly kind = "anthropic" as const;
  readonly id: string;
  readonly capabilities: Capabilities = {
    caching: true,
    structuredOutput: true,
    effort: true,
    batch: false, // batch endpoint wiring is a later step
    vision: true,
    transcription: false,
    // Anthropic has no speech endpoint; a voice interview routes `tts` elsewhere.
    speech: false,
  };
  private readonly client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.id = opts.id;
    this.client =
      opts.client ??
      new Anthropic({
        apiKey: opts.apiKey,
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
        ...(opts.headers ? { defaultHeaders: opts.headers } : {}),
      });
  }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    try {
      for await (const m of this.client.models.list()) {
        out.push({ id: m.id, name: m.display_name });
      }
    } catch (e) {
      throw mapError(e);
    }
    return out;
  }

  async *chat(model: string, req: ChatRequest): AsyncIterable<ChatEvent> {
    const params = this.buildParams(model, req);
    try {
      const stream = this.client.messages.stream(params, req.signal ? { signal: req.signal } : undefined);
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      yield {
        type: "done",
        usage: toUsage(final.usage),
        stopReason: toStopReason(final.stop_reason),
        model: final.model,
      };
    } catch (e) {
      throw mapError(e);
    }
  }

  async complete<T>(
    model: string,
    req: ChatRequest,
    schema: z.ZodType<T>,
  ): Promise<{ value: T; usage: Usage }> {
    const params = this.buildParams(model, req);
    try {
      const res = await this.client.messages.parse(
        {
          ...params,
          output_config: { ...(params.output_config ?? {}), format: zodOutputFormat(schema) },
        },
        req.signal ? { signal: req.signal } : undefined,
      );
      if (res.stop_reason === "refusal") {
        throw new ProviderError("Model refused the request", "refusal", false);
      }
      if (res.parsed_output == null) {
        throw new ProviderError("Structured output did not parse", "parse", true);
      }
      return { value: res.parsed_output, usage: toUsage(res.usage) };
    } catch (e) {
      throw mapError(e);
    }
  }

  // Anthropic has no transcription endpoint; route `transcription` to another provider.

  private buildParams(model: string, req: ChatRequest): Anthropic.MessageCreateParamsNonStreaming {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: req.maxOutputTokens,
      messages: req.messages.map(toAnthropicMessage),
    };
    if (req.system) {
      params.system = req.cachePrefix
        ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
        : req.system;
    }
    if (req.effort) params.output_config = { effort: req.effort };
    // `temperature` is not sent: current Claude models reject sampling parameters.
    return params;
  }
}

function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((p): Anthropic.ContentBlockParam =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image", source: { type: "base64", media_type: p.mime, data: p.base64 } },
    ),
  };
}

function toUsage(u: Anthropic.Usage): Usage {
  return {
    inputTokens: u.input_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens,
  };
}

function toStopReason(r: Anthropic.Message["stop_reason"]): StopReason {
  if (r === "end_turn" || r === "max_tokens" || r === "refusal") return r;
  return "other";
}

export function mapError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(e.message, "auth", false, e);
  }
  if (e instanceof Anthropic.NotFoundError) return new ProviderError(e.message, "not_found", false, e);
  if (e instanceof Anthropic.BadRequestError) return new ProviderError(e.message, "bad_request", false, e);
  if (e instanceof Anthropic.RateLimitError) return new ProviderError(e.message, "rate_limit", true, e);
  if (e instanceof Anthropic.InternalServerError) return new ProviderError(e.message, "server", true, e);
  // APIConnectionError is a subclass of APIError in the TS SDK: check it first.
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError(e.message, "network", true, e);
  if (e instanceof Anthropic.APIError) return new ProviderError(e.message, "server", false, e);
  return new ProviderError(e instanceof Error ? e.message : String(e), "server", false, e);
}

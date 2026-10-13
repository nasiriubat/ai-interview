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
import { guardStream, timeoutError, timeoutsFromEnv, type ProviderTimeouts } from "./resilience.js";
import { ProviderError, upstreamMessage, type Provider } from "./types.js";

export interface AnthropicProviderOptions {
  id: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Test seam: inject a preconfigured client. */
  client?: Anthropic;
  /** The transport the SDK uses; the server passes one that enforces the egress policy. */
  fetch?: typeof fetch;
  /** Deadlines and retries (D-93); the process environment's `PROVIDER_*` values when absent. */
  timeouts?: ProviderTimeouts;
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
    streamingTranscription: false,
  };
  private readonly client: Anthropic;
  private readonly timeouts: ProviderTimeouts;

  constructor(opts: AnthropicProviderOptions) {
    this.id = opts.id;
    this.timeouts = opts.timeouts ?? timeoutsFromEnv();
    this.client =
      opts.client ??
      new Anthropic({
        apiKey: opts.apiKey,
        // Explicit, because the SDK's own defaults are a ten-minute timeout and two hidden
        // retries: a stalled provider held a turn for ten minutes (D-93). The retries are the
        // same bounded number the OpenAI-compatible adapter uses; the SDK backs off between them
        // and honours Retry-After.
        timeout: this.timeouts.totalMs,
        maxRetries: this.timeouts.maxRetries,
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
        ...(opts.headers ? { defaultHeaders: opts.headers } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
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
      const began = Date.now();
      const { signal, deadline } = this.signalFor(req);
      const stream = this.client.messages.stream(params, { signal });
      // The SDK has no first-token deadline: its timeout covers a request that never answers, not
      // one that answers and then goes quiet. This is that deadline, and an idle one. The total
      // ceiling is the `deadline` signal, so a stream that trickles forever is also cut off.
      const events = guardStream(stream, {
        firstMs: this.timeouts.firstTokenMs,
        idleMs: this.timeouts.idleMs,
        since: began,
        isOutput: (e) => e.type === "content_block_delta",
        abort: () => {
          stream.abort();
        },
        label: "Model stream",
      });
      try {
        for await (const event of events) {
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
        throw this.deadlineError(e, deadline, req.signal);
      }
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
    const { signal, deadline } = this.signalFor(req);
    try {
      const res = await this.client.messages.parse(
        {
          ...params,
          output_config: { ...(params.output_config ?? {}), format: zodOutputFormat(schema) },
        },
        { signal },
      );
      if (res.stop_reason === "refusal") {
        throw new ProviderError("Model refused the request", "refusal", false);
      }
      if (res.parsed_output == null) {
        throw new ProviderError("Structured output did not parse", "parse", true);
      }
      return { value: res.parsed_output, usage: toUsage(res.usage) };
    } catch (e) {
      throw this.deadlineError(e, deadline, req.signal);
    }
  }

  /**
   * The signal for one request: the caller's (a barge-in, a lost turn lock, a shutdown) combined
   * with the total deadline, so whichever comes first ends the call. The SDK's own `timeout`
   * bounds one attempt, and its retries are not extended past this ceiling.
   */
  private signalFor(req: ChatRequest): { signal: AbortSignal; deadline: AbortSignal } {
    const deadline = AbortSignal.timeout(this.timeouts.totalMs);
    return { signal: req.signal ? AbortSignal.any([req.signal, deadline]) : deadline, deadline };
  }

  /**
   * A call ended by the deadline is a retryable `timeout`; one ended by the caller is left as the
   * SDK reports it (the model caller turns it into `CallAbortedError`), and is never retried here.
   */
  private deadlineError(e: unknown, deadline: AbortSignal, caller: AbortSignal | undefined): ProviderError {
    if (!caller?.aborted && deadline.aborted && !(e instanceof ProviderError)) {
      return timeoutError("Model call", this.timeouts.totalMs, e);
    }
    return mapError(e);
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

/** Same rule as the OpenAI-compatible adapter: status and identifier, never the response body. */
function sdkMessage(e: { status?: number | undefined; error?: unknown }): string {
  const type = (e.error as { error?: { type?: unknown } } | undefined)?.error?.type;
  return upstreamMessage(e.status, typeof type === "string" ? type : undefined);
}

export function mapError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(sdkMessage(e), "auth", false, e);
  }
  if (e instanceof Anthropic.NotFoundError) return new ProviderError(sdkMessage(e), "not_found", false, e);
  if (e instanceof Anthropic.BadRequestError)
    return new ProviderError(sdkMessage(e), "bad_request", false, e);
  if (e instanceof Anthropic.RateLimitError) return new ProviderError(sdkMessage(e), "rate_limit", true, e);
  if (e instanceof Anthropic.InternalServerError) return new ProviderError(sdkMessage(e), "server", true, e);
  // A timeout is a subclass of APIConnectionError, so it is checked before it (D-93).
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return new ProviderError("The provider did not answer in time", "timeout", true, e);
  // APIConnectionError is a subclass of APIError in the TS SDK: check it first.
  if (e instanceof Anthropic.APIConnectionError) {
    return new ProviderError("Network error calling the provider", "network", true, e);
  }
  if (e instanceof Anthropic.APIError) return new ProviderError(sdkMessage(e), "server", false, e);
  return new ProviderError("Provider request failed", "server", false, e);
}

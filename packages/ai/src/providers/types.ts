import type {
  Capabilities,
  ChatEvent,
  ChatRequest,
  ModelInfo,
  ProviderKind,
  SpeechInput,
  SpeechOutput,
  SttStreamInput,
  SttStreamSession,
  Transcript,
  TranscriptionInput,
  Usage,
} from "@aidp/shared";
import type { z } from "zod";

/**
 * Every provider adapter implements this. The engine never talks to an SDK directly;
 * it goes through `callModel`, which resolves a route, checks budget, invokes the
 * adapter and writes the ledger.
 */
export interface Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly capabilities: Capabilities;
  listModels(): Promise<ModelInfo[]>;
  chat(model: string, req: ChatRequest): AsyncIterable<ChatEvent>;
  complete<T>(
    model: string,
    req: ChatRequest,
    schema: z.ZodType<T>,
    schemaName?: string,
  ): Promise<{ value: T; usage: Usage }>;
  transcribe?(model: string, input: TranscriptionInput): Promise<{ transcript: Transcript; usage: Usage }>;
  /** Text embeddings, when the provider offers them (OpenAI-compatible `/embeddings`). */
  embed?(model: string, texts: string[]): Promise<{ vectors: number[][]; usage: Usage }>;
  /**
   * Text to speech, streamed (FR-30a).
   *
   * `signal` is not optional politeness: barge-in means the participant starts talking over the
   * interviewer, and the synthesis in flight has to stop immediately — both so the audio stops and
   * so the tokens stop being paid for.
   */
  speak?(model: string, input: SpeechInput, signal?: AbortSignal): Promise<SpeechOutput>;
  /**
   * Streaming speech to text (FR-30a, D-77): audio is pushed as it is captured and transcripts
   * come back while the participant is still talking.
   *
   * Resolves once the provider has accepted the session, so a bad key or an unreachable host is a
   * rejected promise at the start of a call rather than silence in the middle of one. The caller
   * owns the returned session and must close it.
   */
  transcribeStream?(model: string, input: SttStreamInput): Promise<SttStreamSession>;
}

/**
 * The smallest socket the streaming adapters need, so a test can hand in a fake server instead of
 * the network. `ws` satisfies it as it is; see `providers/realtime-socket.ts`.
 */
export interface RealtimeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: "close", listener: (code: number, reason: unknown) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}
export type RealtimeSocketFactory = (url: string, headers: Record<string, string>) => RealtimeSocket;

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "auth"
      | "rate_limit"
      | "bad_request"
      | "not_found"
      | "server"
      | "network"
      | "refusal"
      | "parse"
      | "unsupported",
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Upstream error identifiers short and boring enough to repeat: `invalid_api_key`, `rate_limit_exceeded`. */
const SAFE_CODE = /^[a-z0-9_.-]{1,48}$/i;

/**
 * The message a ProviderError carries: the status and, when the upstream named one, its
 * identifier. Never the response body. A provider URL is chosen by a tenant admin, so anything the
 * server at that URL says is attacker-controlled text; echoing it back through `/test` or `/models`
 * would turn a blind request into a read of whatever the server could be pointed at (SSRF). The
 * full body stays on `cause`, for the debug log, where it is redacted of credentials first.
 */
export function upstreamMessage(status: number | undefined, code?: string): string {
  const base = status === undefined ? "Provider request failed" : `Provider returned ${status}`;
  return code && SAFE_CODE.test(code) ? `${base} (${code})` : base;
}

/** Truncates an upstream body for the log and removes the credential if the server echoed it. */
export function redactedBody(text: string, secrets: string[]): string {
  let out = text.slice(0, 500);
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [redacted]");
}

/**
 * The audio is in a container this provider cannot read. Still `unsupported`, so every existing
 * fallback treats it as "this route cannot do it", but a distinct class because the remedy is
 * different from a missing route: the on-server Whisper reads only WAV, and the browser is meant to
 * have converted the recording before uploading it (D-75). Recorded voice does that conversion;
 * live voice streams WebM and does not.
 */
export class UnsupportedAudioError extends ProviderError {
  constructor(message: string, cause?: unknown) {
    super(message, "unsupported", false, cause);
    this.name = "UnsupportedAudioError";
  }
}

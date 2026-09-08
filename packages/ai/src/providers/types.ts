import type { z } from "zod";
import type { Capabilities, ChatEvent, ChatRequest, ModelInfo, ProviderKind, Transcript, TranscriptionInput } from "@aidp/shared";

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
  complete<T>(model: string, req: ChatRequest, schema: z.ZodType<T>, schemaName?: string): Promise<{ value: T; usage: import("@aidp/shared").Usage }>;
  transcribe?(model: string, input: TranscriptionInput): Promise<{ transcript: Transcript; usage: import("@aidp/shared").Usage }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: "auth" | "rate_limit" | "bad_request" | "not_found" | "server" | "network" | "refusal" | "parse" | "unsupported",
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

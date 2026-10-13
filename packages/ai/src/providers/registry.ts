import type { ProviderConfig, ProviderKind, Purpose } from "@aidp/shared";
import { AnthropicProvider } from "./anthropic.js";
import type { SpeechRunner } from "./local-whisper/runner.js";
import { LocalWhisperProvider } from "./local-whisper.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ProviderTimeouts } from "./resilience.js";
import type { Provider, RealtimeSocketFactory } from "./types.js";

export interface ProviderDeps {
  fetch?: typeof fetch;
  /** The socket streaming adapters open; tests hand in a fake server. */
  socket?: RealtimeSocketFactory;
  /** The on-server Whisper runner; defaults to the process-wide one. Tests pass a fake. */
  speech?: SpeechRunner;
  /** Deadlines and retries for every adapter built here (D-93); `PROVIDER_*` environment when absent. */
  timeouts?: ProviderTimeouts;
}

/** Build an adapter from a (decrypted) provider row. Adding a kind touches this file and one adapter. */
export function createProvider(cfg: ProviderConfig, deps: ProviderDeps = {}): Provider {
  if (cfg.kind === "local") {
    return new LocalWhisperProvider({ id: cfg.id, ...(deps.speech ? { runner: deps.speech } : {}) });
  }
  if (cfg.kind === "anthropic") {
    return new AnthropicProvider({
      id: cfg.id,
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}),
      ...(deps.timeouts ? { timeouts: deps.timeouts } : {}),
    });
  }
  return new OpenAICompatibleProvider({
    id: cfg.id,
    kind: cfg.kind,
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    headers: cfg.headers,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.socket ? { socket: deps.socket } : {}),
    ...(deps.timeouts ? { timeouts: deps.timeouts } : {}),
  });
}

/** The purposes that need audio endpoints: Anthropic has none and OpenRouter proxies chat models only. */
const AUDIO_PURPOSES: ReadonlySet<Purpose> = new Set([
  "transcription",
  "stt_stream",
  "tts",
  "realtime_voice",
]);

/**
 * Whether a provider of this kind can serve a purpose at all, without building an adapter or
 * decrypting a key. Mirrors the adapters' `capabilities` for the audio purposes, which are the
 * only ones a kind cannot serve; used by the admin's live voice readiness check.
 */
export function kindSupportsPurpose(kind: ProviderKind, purpose: Purpose): boolean {
  // On-server Whisper (D-75) transcribes a finished recording and does nothing else: it has no
  // streaming socket, no voice, and no chat model.
  if (kind === "local") return purpose === "transcription";
  if (!AUDIO_PURPOSES.has(purpose)) return true;
  return kind !== "anthropic" && kind !== "openrouter";
}

/** Caches adapters per provider id so clients are reused across calls. */
export class ProviderRegistry {
  private readonly cache = new Map<string, { config: ProviderConfig; provider: Provider }>();
  constructor(private readonly deps: ProviderDeps = {}) {}

  get(cfg: ProviderConfig): Provider {
    const hit = this.cache.get(cfg.id);
    if (hit && sameConfig(hit.config, cfg)) return hit.provider;
    const provider = createProvider(cfg, this.deps);
    this.cache.set(cfg.id, { config: cfg, provider });
    return provider;
  }

  invalidate(id: string): void {
    this.cache.delete(id);
  }
}

function sameConfig(a: ProviderConfig, b: ProviderConfig): boolean {
  return (
    a.kind === b.kind &&
    a.apiKey === b.apiKey &&
    a.baseUrl === b.baseUrl &&
    JSON.stringify(a.headers) === JSON.stringify(b.headers)
  );
}

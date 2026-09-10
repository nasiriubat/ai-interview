import type { ProviderConfig } from "@aidp/shared";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

/** Build an adapter from a (decrypted) provider row. Adding a kind touches this file and one adapter. */
export function createProvider(cfg: ProviderConfig, deps: { fetch?: typeof fetch } = {}): Provider {
  if (cfg.kind === "anthropic") {
    return new AnthropicProvider({
      id: cfg.id,
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}),
    });
  }
  return new OpenAICompatibleProvider({
    id: cfg.id,
    kind: cfg.kind,
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    headers: cfg.headers,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

/** Caches adapters per provider id so clients are reused across calls. */
export class ProviderRegistry {
  private readonly cache = new Map<string, { config: ProviderConfig; provider: Provider }>();
  constructor(private readonly deps: { fetch?: typeof fetch } = {}) {}

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

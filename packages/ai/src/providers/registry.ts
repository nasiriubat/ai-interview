import type { ProviderConfig } from "@aidp/shared";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { Provider } from "./types.js";

/**
 * How adapters reach the network. `fetch` is a single implementation for every provider (tests);
 * `fetchFor` chooses per provider, which is how the server applies an egress policy that depends
 * on who owns the provider (a tenant's base URL is held to a stricter rule than the operator's).
 * This package knows nothing about the policy itself, only that a `fetch` arrives.
 */
export interface FetchDeps {
  fetch?: typeof fetch;
  fetchFor?: (cfg: ProviderConfig) => typeof fetch | undefined;
}

/** Build an adapter from a (decrypted) provider row. Adding a kind touches this file and one adapter. */
export function createProvider(cfg: ProviderConfig, deps: FetchDeps = {}): Provider {
  const fetchImpl = deps.fetchFor?.(cfg) ?? deps.fetch;
  if (cfg.kind === "anthropic") {
    return new AnthropicProvider({
      id: cfg.id,
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(Object.keys(cfg.headers).length ? { headers: cfg.headers } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }
  return new OpenAICompatibleProvider({
    id: cfg.id,
    kind: cfg.kind,
    apiKey: cfg.apiKey,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    headers: cfg.headers,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/** Caches adapters per provider id so clients are reused across calls. */
export class ProviderRegistry {
  private readonly cache = new Map<string, { config: ProviderConfig; provider: Provider }>();
  constructor(private readonly deps: FetchDeps = {}) {}

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

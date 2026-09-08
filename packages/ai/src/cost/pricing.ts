import type { ModelInfo, Usage } from "@aidp/shared";

export interface ModelPrice {
  providerId: string;
  model: string;
  inputPerMtok: number; // USD
  cachedInputPerMtok: number;
  outputPerMtok: number;
  source: "seed" | "admin" | "provider";
}

/** Seed prices for first-party providers (USD per million tokens). Admin-editable at runtime. */
export const SEED_PRICES: ReadonlyArray<Omit<ModelPrice, "providerId">> = [
  { model: "claude-fable-5-1", inputPerMtok: 10, cachedInputPerMtok: 0.25, outputPerMtok: 50, source: "seed" },
  { model: "claude-opus-5", inputPerMtok: 5, cachedInputPerMtok: 0.5, outputPerMtok: 25, source: "seed" },
  { model: "claude-sonnet-5", inputPerMtok: 2, cachedInputPerMtok: 0.2, outputPerMtok: 10, source: "seed" },
  { model: "claude-haiku-4-5", inputPerMtok: 1, cachedInputPerMtok: 0.1, outputPerMtok: 5, source: "seed" },
];

/**
 * In-memory price table. The database-backed implementation (packages/db) has the same
 * shape; this one is used by tests, evals and the CLI.
 */
export class PriceTable {
  private readonly prices = new Map<string, ModelPrice>();

  constructor(initial: ModelPrice[] = []) {
    for (const p of initial) this.set(p);
  }

  static withSeeds(providerId: string): PriceTable {
    return new PriceTable(SEED_PRICES.map((p) => ({ ...p, providerId })));
  }

  set(p: ModelPrice): void {
    this.prices.set(key(p.providerId, p.model), p);
  }

  get(providerId: string, model: string): ModelPrice | undefined {
    return this.prices.get(key(providerId, model));
  }

  /** Import prices a provider published in its model list. Never overwrites an admin override. */
  importFromModels(providerId: string, models: ModelInfo[]): number {
    let n = 0;
    for (const m of models) {
      if (m.inputPerMtok === undefined || m.outputPerMtok === undefined) continue;
      const existing = this.get(providerId, m.id);
      if (existing?.source === "admin") continue;
      this.set({
        providerId,
        model: m.id,
        inputPerMtok: m.inputPerMtok,
        cachedInputPerMtok: m.cachedInputPerMtok ?? m.inputPerMtok,
        outputPerMtok: m.outputPerMtok,
        source: "provider",
      });
      n++;
    }
    return n;
  }
}

/** Cost in cents, fractional. Cache writes are charged at input price (the 1.25x write premium is folded into the estimate elsewhere). */
export function costCents(price: ModelPrice, usage: Usage): number {
  const dollars =
    (usage.inputTokens * price.inputPerMtok +
      usage.cacheReadTokens * price.cachedInputPerMtok +
      usage.cacheWriteTokens * price.inputPerMtok * 1.25 +
      usage.outputTokens * price.outputPerMtok) /
    1_000_000;
  return dollars * 100;
}

/** Conservative pre-call estimate: all input at full price, output at the max allowed. */
export function estimateCents(price: ModelPrice, estimatedInputTokens: number, maxOutputTokens: number): number {
  return costCents(price, { inputTokens: estimatedInputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: maxOutputTokens });
}

/** Rough token estimate for budget checks. Real counts come from the provider afterwards. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function key(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

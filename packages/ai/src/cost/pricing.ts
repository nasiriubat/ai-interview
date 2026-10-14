import type { ModelInfo, Usage } from "@aidp/shared";

export interface ModelPrice {
  providerId: string;
  model: string;
  inputPerMtok: number; // USD
  cachedInputPerMtok: number;
  outputPerMtok: number;
  /** USD per minute of audio, for speech-to-text models (D-220). Absent: audio is not priced. */
  audioPerMinute?: number;
  /** USD per million characters, for text-to-speech models (D-220). Absent: speech is not priced. */
  ttsPerMChars?: number;
  source: "seed" | "admin" | "provider";
}

/** Seed prices for first-party providers (USD per million tokens). Admin-editable at runtime. */
export const SEED_PRICES: readonly Omit<ModelPrice, "providerId">[] = [
  {
    model: "claude-fable-5-1",
    inputPerMtok: 10,
    cachedInputPerMtok: 0.25,
    outputPerMtok: 50,
    source: "seed",
  },
  { model: "claude-opus-5", inputPerMtok: 5, cachedInputPerMtok: 0.5, outputPerMtok: 25, source: "seed" },
  { model: "claude-sonnet-5", inputPerMtok: 2, cachedInputPerMtok: 0.2, outputPerMtok: 10, source: "seed" },
  { model: "claude-haiku-4-5", inputPerMtok: 1, cachedInputPerMtok: 0.1, outputPerMtok: 5, source: "seed" },
];

/**
 * Seed prices for the OpenAI speech models, applied to the platform OpenAI provider at bootstrap
 * (USD; token fields zero because these models bill by audio minute or character).
 */
export const OPENAI_AUDIO_SEED_PRICES: readonly Omit<ModelPrice, "providerId">[] = [
  {
    model: "whisper-1",
    inputPerMtok: 0,
    cachedInputPerMtok: 0,
    outputPerMtok: 0,
    audioPerMinute: 0.006,
    source: "seed",
  },
  {
    model: "gpt-4o-mini-transcribe",
    inputPerMtok: 0,
    cachedInputPerMtok: 0,
    outputPerMtok: 0,
    audioPerMinute: 0.003,
    source: "seed",
  },
  {
    model: "gpt-4o-transcribe",
    inputPerMtok: 0,
    cachedInputPerMtok: 0,
    outputPerMtok: 0,
    audioPerMinute: 0.006,
    source: "seed",
  },
  {
    model: "tts-1",
    inputPerMtok: 0,
    cachedInputPerMtok: 0,
    outputPerMtok: 0,
    ttsPerMChars: 15,
    source: "seed",
  },
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
      const audioOnly =
        m.inputPerMtok === undefined &&
        m.outputPerMtok === undefined &&
        (m.audioPerMinute !== undefined || m.ttsPerMChars !== undefined);
      if (!audioOnly && (m.inputPerMtok === undefined || m.outputPerMtok === undefined)) continue;
      const existing = this.get(providerId, m.id);
      if (existing?.source === "admin") continue;
      this.set({
        providerId,
        model: m.id,
        inputPerMtok: m.inputPerMtok ?? 0,
        cachedInputPerMtok: m.cachedInputPerMtok ?? m.inputPerMtok ?? 0,
        outputPerMtok: m.outputPerMtok ?? 0,
        ...(m.audioPerMinute !== undefined ? { audioPerMinute: m.audioPerMinute } : {}),
        ...(m.ttsPerMChars !== undefined ? { ttsPerMChars: m.ttsPerMChars } : {}),
        source: "provider",
      });
      n++;
    }
    return n;
  }
}

/**
 * Cost in cents, fractional. Cache writes are charged at input price (the 1.25x write premium is
 * folded into the estimate elsewhere). Audio is charged per minute and speech per million
 * characters, when the model has a price for them (D-220).
 */
export function costCents(price: ModelPrice, usage: Usage): number {
  const tokens =
    (usage.inputTokens * price.inputPerMtok +
      usage.cacheReadTokens * price.cachedInputPerMtok +
      usage.cacheWriteTokens * price.inputPerMtok * 1.25 +
      usage.outputTokens * price.outputPerMtok) /
    1_000_000;
  const audio = ((usage.audioSeconds ?? 0) / 60) * (price.audioPerMinute ?? 0);
  const speech = ((usage.ttsCharacters ?? 0) / 1_000_000) * (price.ttsPerMChars ?? 0);
  return (tokens + audio + speech) * 100;
}

/** Conservative pre-call estimate: all input at full price, output at the max allowed. */
export function estimateCents(
  price: ModelPrice,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number {
  return costCents(price, {
    inputTokens: estimatedInputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: maxOutputTokens,
  });
}

/** Rough token estimate for budget checks. Real counts come from the provider afterwards. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function key(providerId: string, model: string): string {
  return `${providerId}::${model}`;
}

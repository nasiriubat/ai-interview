import {
  FACTOR_KEYS,
  type FactorKey,
  type Factors,
  type OpportunityOverride,
  rankScore,
  type SolutionClass,
  WEIGHT_PRESETS,
  type Weights,
} from "@aidp/shared";

/*
 * Client-side ranking. The API re-ranks stored opportunities from their factors on every
 * GET; the web does the same with `rankScore` from @aidp/shared so a weight change shows
 * its effect immediately, before the settings PUT lands.
 */

export const WEIGHT_PRESET_KEYS = ["balanced", "quick_wins", "strategic", "custom"] as const;
export type WeightsPreset = (typeof WEIGHT_PRESET_KEYS)[number];

export function isWeightsPreset(value: unknown): value is WeightsPreset {
  return typeof value === "string" && (WEIGHT_PRESET_KEYS as readonly string[]).includes(value);
}

/** Reads an `analysis.weights` settings value; unknown keys are ignored, missing keys default to 1. */
export function parseWeights(raw: unknown): Weights {
  const out = { ...WEIGHT_PRESETS.balanced };
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    for (const k of FACTOR_KEYS) {
      const v = rec[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(5, Math.max(0, v));
    }
  }
  return out;
}

/** The weights in force for a preset: a shipped preset, or the custom vector. */
export function effectiveWeights(preset: WeightsPreset, custom: Weights): Weights {
  return preset === "custom" ? custom : WEIGHT_PRESETS[preset];
}

/** Which preset a weight vector corresponds to, or `custom` when it matches none. */
export function presetForWeights(weights: Weights): WeightsPreset {
  for (const key of ["balanced", "quick_wins", "strategic"] as const) {
    const p = WEIGHT_PRESETS[key];
    if (FACTOR_KEYS.every((k) => p[k] === weights[k])) return key;
  }
  return "custom";
}

export interface Rankable {
  title: string;
  solutionClass: SolutionClass;
  factors: Factors;
  adminOverride: OpportunityOverride | null;
}

/** Admin factor overrides applied over the generated factors; a rationale is kept when the override gives none. */
export function effectiveFactors(o: Pick<Rankable, "factors" | "adminOverride">): Factors {
  const overrides = o.adminOverride?.factors;
  if (!overrides) return o.factors;
  const out = { ...o.factors };
  for (const k of FACTOR_KEYS) {
    const ov = overrides[k];
    if (!ov) continue;
    out[k] = { score: ov.score, rationale: ov.rationale || o.factors[k].rationale };
  }
  return out;
}

export function effectiveTitle(o: Pick<Rankable, "title" | "adminOverride">): string {
  return o.adminOverride?.title ?? o.title;
}

export function effectiveClass(o: Pick<Rankable, "solutionClass" | "adminOverride">): SolutionClass {
  return o.adminOverride?.solutionClass ?? o.solutionClass;
}

export function isFactorOverridden(o: Pick<Rankable, "adminOverride">, key: FactorKey): boolean {
  return o.adminOverride?.factors?.[key] !== undefined;
}

/** Recomputes every rank under `weights` and sorts highest first (ties by title). */
export function rerank<T extends Rankable & { rankScore: number }>(
  items: readonly T[],
  weights: Weights,
): T[] {
  return items
    .map((o) => ({ ...o, rankScore: rankScore(effectiveFactors(o), weights) }))
    .sort((a, b) => b.rankScore - a.rankScore || effectiveTitle(a).localeCompare(effectiveTitle(b)));
}

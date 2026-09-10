import { FACTOR_KEYS, type FactorKey, type OpportunityOverride, type SolutionClass } from "@aidp/shared";
import type { Rankable } from "./rank";

/*
 * State of the "edit override" sheet. The draft holds only what the admin has set;
 * `toOverridePayload` turns it into the contract's `OpportunityOverride`, dropping values
 * equal to the generated ones so the stored override stays minimal.
 */

export interface FactorDraft {
  score: number;
  rationale: string;
}

export interface OverrideDraft {
  title: string;
  solutionClass: SolutionClass | "";
  factors: Partial<Record<FactorKey, FactorDraft>>;
  note: string;
}

export type OverrideAction =
  | { type: "title"; value: string }
  | { type: "class"; value: SolutionClass | "" }
  | { type: "factorScore"; key: FactorKey; score: number | null }
  | { type: "factorRationale"; key: FactorKey; rationale: string }
  | { type: "note"; value: string }
  | { type: "clear" };

export const EMPTY_DRAFT: OverrideDraft = { title: "", solutionClass: "", factors: {}, note: "" };

/** Seeds the draft from the stored override (empty when the opportunity is untouched). */
export function draftFromOverride(override: OpportunityOverride | null | undefined): OverrideDraft {
  if (!override) return EMPTY_DRAFT;
  const factors: OverrideDraft["factors"] = {};
  for (const k of FACTOR_KEYS) {
    const f = override.factors?.[k];
    if (f) factors[k] = { score: f.score, rationale: f.rationale };
  }
  return {
    title: override.title ?? "",
    solutionClass: override.solutionClass ?? "",
    factors,
    note: override.note ?? "",
  };
}

function clampScore(n: number): number {
  return Math.min(5, Math.max(1, Math.round(n)));
}

export function overrideReducer(state: OverrideDraft, action: OverrideAction): OverrideDraft {
  switch (action.type) {
    case "title":
      return { ...state, title: action.value };
    case "class":
      return { ...state, solutionClass: action.value };
    case "note":
      return { ...state, note: action.value };
    case "factorScore": {
      if (action.score === null) {
        const { [action.key]: _removed, ...rest } = state.factors;
        return { ...state, factors: rest };
      }
      return {
        ...state,
        factors: {
          ...state.factors,
          [action.key]: {
            score: clampScore(action.score),
            rationale: state.factors[action.key]?.rationale ?? "",
          },
        },
      };
    }
    case "factorRationale": {
      const current = state.factors[action.key];
      if (!current) return state;
      return {
        ...state,
        factors: { ...state.factors, [action.key]: { ...current, rationale: action.rationale } },
      };
    }
    case "clear":
      return EMPTY_DRAFT;
  }
}

/**
 * The PATCH body. Values equal to the generated ones are left out; an empty result means
 * "no override". Factor rationales are only sent when non-empty (the API keeps the
 * generated rationale otherwise; see README, contract gaps).
 */
export function toOverridePayload(draft: OverrideDraft, base: Rankable): OpportunityOverride {
  const out: OpportunityOverride = {};
  const title = draft.title.trim();
  if (title && title !== base.title) out.title = title;
  if (draft.solutionClass && draft.solutionClass !== base.solutionClass) {
    out.solutionClass = draft.solutionClass;
  }
  const factors: NonNullable<OpportunityOverride["factors"]> = {};
  for (const k of FACTOR_KEYS) {
    const f = draft.factors[k];
    if (!f) continue;
    const rationale = f.rationale.trim();
    if (f.score === base.factors[k].score && !rationale) continue;
    factors[k] = { score: f.score, rationale: rationale || base.factors[k].rationale };
  }
  if (Object.keys(factors).length > 0) out.factors = factors;
  const note = draft.note.trim();
  if (note) out.note = note;
  return out;
}

export function isEmptyOverride(override: OpportunityOverride): boolean {
  return Object.keys(override).length === 0;
}

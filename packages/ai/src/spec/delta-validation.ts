import { normalizeSectionKey, type Fact, type SessionState } from "@aidp/shared";
import { asObject, scopeOf, titleOf } from "./live.js";

/**
 * Validation of the spec_field facts in a state delta against the specification's own schema
 * (D-190). The live runs of 2026-10-14 showed what free text in a spec field does: one interview
 * filed 140 items under `rules` and none as `FR-n`, so the generated specification had one
 * requirement. A delta is checked here before it reaches state: section keys are canonical,
 * functional requirements carry a sequential unique `FR-n` id, a title, a scope and an
 * acceptance list, and a requirement filed under another section is moved to `functional`.
 *
 * What cannot be settled deterministically is returned as `rejected`, and the engine asks the
 * model to rebuild exactly those facts (`turn-repair.ts`).
 */

export type SpecFact = Extract<Fact, { kind: "spec_field" }>;

export type RejectionReason = "unknown_section" | "bad_requirement" | "rules_without_requirements";

export interface FactRejection {
  reason: RejectionReason;
  section: string;
  path: string;
  detail: string;
}

export interface FactRepair {
  kind: "section_normalized" | "moved_to_functional" | "renumbered" | "coerced" | "deduplicated";
  section: string;
  path: string;
  detail: string;
}

export interface DeltaCheck {
  /** The facts that may enter state, normalized. */
  facts: Fact[];
  /** What was fixed deterministically. */
  repaired: FactRepair[];
  /** What was held back for a model repair. */
  rejected: FactRejection[];
  /** The rejected facts themselves, so a last resort can still file them. */
  heldBack: SpecFact[];
}

const FR_ID = /^FR-(\d+)$/i;
/** `FR-1.acceptance`, `FR-1/acceptance`, `FR-1 acceptance criteria`, ... */
const ACCEPTANCE_PATH = /^(FR-\d+)[\s._/:-]+(?:acceptance|criteria|ac)\b/i;
/** Rules at or above this count with no requirement recorded read as the 2026-10-14 failure. */
export const RULES_FLOOD_THRESHOLD = 6;

/** The numeric part of an FR id, or undefined for any other path. */
export function requirementNumber(path: string): number | undefined {
  const m = FR_ID.exec(path.trim());
  return m?.[1] ? Number(m[1]) : undefined;
}

const isFunctionalRequirement = (f: Fact): f is SpecFact =>
  f.kind === "spec_field" &&
  (normalizeSectionKey(f.section) ?? f.section) === "functional" &&
  f.value !== null &&
  typeof f.value === "object" &&
  !Array.isArray(f.value);

/** The number the next requirement takes: one past the highest id recorded. */
export function nextRequirementNumber(state: Pick<SessionState, "facts">): number {
  let max = 0;
  for (const f of state.facts) {
    if (f.kind !== "spec_field") continue;
    const n = requirementNumber(f.path);
    if (n !== undefined && (normalizeSectionKey(f.section) ?? f.section) === "functional")
      max = Math.max(max, n);
  }
  return max + 1;
}

/** A value that is plainly a requirement: an FR path, or a titled object with scope or acceptance. */
export function looksLikeRequirement(path: string, value: unknown): boolean {
  if (/^FR[-_ ]?\w*/i.test(path.trim()) && /^FR[-_ ]?\d+$/i.test(path.trim())) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const titled = ["title", "name", "summary"].some((k) => typeof v[k] === "string");
  const shaped = "acceptance" in v || "scope" in v || "mvp" in v || "future" in v;
  return titled && shaped;
}

const normalizeTitle = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, " ");

function coerceRequirement(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const title = value.trim();
    return title ? { title, scope: "mvp", acceptance: [] } : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = asObject(value);
  const title =
    titleOf(value, "") ||
    (typeof v.description === "string" ? v.description.trim().slice(0, 120) : "") ||
    (typeof v.requirement === "string" ? v.requirement.trim() : "");
  if (!title) return undefined;
  const acceptanceRaw = v.acceptance ?? v.acceptanceCriteria ?? v.acceptance_criteria;
  const acceptance = Array.isArray(acceptanceRaw)
    ? acceptanceRaw.filter((a): a is string => typeof a === "string" && a.trim() !== "")
    : typeof acceptanceRaw === "string" && acceptanceRaw.trim()
      ? [acceptanceRaw.trim()]
      : [];
  const out: Record<string, unknown> = { title, scope: scopeOf(value), acceptance };
  if (typeof v.description === "string" && v.description.trim() && v.description.trim() !== title)
    out.description = v.description.trim();
  if (typeof v.reason === "string" && v.reason.trim()) out.reason = v.reason.trim();
  return out;
}

export interface CheckOptions {
  /** Whether the template produces a specification at all; other facts pass through untouched. */
  producesSpec: boolean;
}

/**
 * Checks the facts of one delta against the state they will be merged into. Order is kept; ids are
 * assigned in capture order so the result is deterministic.
 */
export function checkSpecFacts(
  incoming: Fact[],
  state: Pick<SessionState, "facts">,
  options: CheckOptions = { producesSpec: true },
): DeltaCheck {
  const out: DeltaCheck = { facts: [], repaired: [], rejected: [], heldBack: [] };
  if (!options.producesSpec) return { ...out, facts: incoming };

  const existingFr = new Map<string, string>(); // normalized title -> id
  const existingIds = new Set<string>();
  for (const f of state.facts) {
    if (!isFunctionalRequirement(f)) continue;
    existingIds.add(f.path.toUpperCase());
    const t = titleOf(f.value, "");
    if (t) existingFr.set(normalizeTitle(t), f.path.toUpperCase());
  }
  let next = nextRequirementNumber(state);
  const assigned = new Set<string>();
  /** A numbered id the model used that was moved, so a second mention lands on the same requirement. */
  const renamed = new Map<string, string>();
  const rulesInState = state.facts.filter(
    (f) => f.kind === "spec_field" && (normalizeSectionKey(f.section) ?? f.section) === "rules",
  ).length;
  const requirementsInState = existingIds.size;
  let rulesAdded = 0;
  let requirementsAdded = 0;
  const heldRules: SpecFact[] = [];

  const file = (fact: SpecFact, sectionKey: string): void => {
    out.facts.push({ ...fact, section: sectionKey });
  };

  for (const f of incoming) {
    if (f.kind !== "spec_field") {
      out.facts.push(f);
      continue;
    }
    const canonical = normalizeSectionKey(f.section);
    const path = f.path.trim();
    let section = canonical ?? f.section;

    if (canonical === undefined) {
      if (looksLikeRequirement(path, f.value)) {
        out.repaired.push({
          kind: "moved_to_functional",
          section: f.section,
          path,
          detail: `unknown section "${f.section}" holds a requirement`,
        });
        section = "functional";
      } else {
        out.rejected.push({
          reason: "unknown_section",
          section: f.section,
          path,
          detail: `"${f.section}" is not a specification section`,
        });
        out.heldBack.push(f);
        continue;
      }
    } else if (canonical !== f.section) {
      out.repaired.push({
        kind: "section_normalized",
        section: f.section,
        path,
        detail: `${f.section} -> ${canonical}`,
      });
    }

    if (section !== "functional" && canonical !== undefined && looksLikeRequirement(path, f.value)) {
      // A requirement filed under another section (the 140-rules failure): move it.
      out.repaired.push({
        kind: "moved_to_functional",
        section: f.section,
        path,
        detail: `requirement filed under "${section}"`,
      });
      section = "functional";
    }

    if (section !== "functional") {
      if (section === "rules") {
        rulesAdded += 1;
        heldRules.push(f);
      }
      file(f, section);
      continue;
    }

    // Acceptance criteria written as their own field ("FR-1.acceptance", or a fact in the
    // `acceptance` section): they belong on the requirement, not beside it.
    const ac = ACCEPTANCE_PATH.exec(path);
    if (ac?.[1] && (typeof f.value === "string" || Array.isArray(f.value))) {
      const target = ac[1].toUpperCase();
      const current =
        out.facts.find((x) => x.kind === "spec_field" && x.section === "functional" && x.path === target) ??
        state.facts.find(
          (x) =>
            x.kind === "spec_field" &&
            (normalizeSectionKey(x.section) ?? x.section) === "functional" &&
            x.path.toUpperCase() === target,
        );
      const base = current?.kind === "spec_field" ? coerceRequirement(current.value) : undefined;
      if (base) {
        const extra = (Array.isArray(f.value) ? f.value : [f.value])
          .filter((a): a is string => typeof a === "string" && a.trim() !== "")
          .map((a) => a.trim());
        const have = (base.acceptance as string[]).map((a) => a.toLowerCase());
        const merged = {
          ...base,
          acceptance: [
            ...(base.acceptance as string[]),
            ...extra.filter((a) => !have.includes(a.toLowerCase())),
          ],
        };
        const fact: SpecFact = { ...f, section: "functional", path: target, value: merged };
        const at = out.facts.findIndex(
          (x) => x.kind === "spec_field" && x.section === "functional" && x.path === target,
        );
        if (at >= 0) out.facts[at] = fact;
        else out.facts.push(fact);
        out.repaired.push({
          kind: "coerced",
          section: "functional",
          path,
          detail: `acceptance criteria moved onto ${target}`,
        });
        continue;
      }
    }
    // A plain note in the functional section that is not a requirement id stays a note.
    if (typeof f.value === "string" && requirementNumber(path) === undefined) {
      file(f, "functional");
      continue;
    }

    // Functional requirement: shape, id, scope, acceptance.
    const value = coerceRequirement(f.value);
    if (!value) {
      out.rejected.push({
        reason: "bad_requirement",
        section: "functional",
        path,
        detail: "a functional requirement needs a title",
      });
      out.heldBack.push(f);
      continue;
    }
    if (typeof f.value !== "object" || Array.isArray(f.value) || f.value === null)
      out.repaired.push({
        kind: "coerced",
        section: "functional",
        path,
        detail: "plain text recorded as a requirement",
      });
    const title = String(value.title);
    let id = path.toUpperCase();
    const n = requirementNumber(path);
    const known = existingIds.has(id) || assigned.has(id);
    const renamedTo = renamed.get(id);
    if (n === undefined) {
      const same = existingFr.get(normalizeTitle(title));
      if (same) {
        id = same;
        out.repaired.push({
          kind: "deduplicated",
          section: "functional",
          path,
          detail: `same title as ${same}`,
        });
      } else {
        id = `FR-${next}`;
        out.repaired.push({ kind: "renumbered", section: "functional", path, detail: `${path} -> ${id}` });
      }
    } else if (renamedTo !== undefined) {
      id = renamedTo;
    } else if (!known && n > next) {
      renamed.set(id, `FR-${next}`);
      id = `FR-${next}`;
      out.repaired.push({ kind: "renumbered", section: "functional", path, detail: `${path} -> ${id}` });
    } else {
      id = `FR-${n}`;
    }
    if (!existingIds.has(id) && !assigned.has(id)) {
      assigned.add(id);
      requirementsAdded += 1;
      const num = requirementNumber(id) ?? 0;
      if (num >= next) next = num + 1;
    }
    existingFr.set(normalizeTitle(title), id);
    // A replacement inside one delta (same id twice) keeps the later one.
    const dup = out.facts.findIndex(
      (x) => x.kind === "spec_field" && x.section === "functional" && x.path === id,
    );
    const fact: SpecFact = { ...f, section: "functional", path: id, value };
    if (dup >= 0) out.facts[dup] = fact;
    else out.facts.push(fact);
  }

  // The 2026-10-14 signature: a pile of rules and not a single requirement anywhere.
  if (
    rulesInState + rulesAdded >= RULES_FLOOD_THRESHOLD &&
    requirementsInState + requirementsAdded === 0 &&
    rulesAdded > 0
  ) {
    out.rejected.push({
      reason: "rules_without_requirements",
      section: "rules",
      path: heldRules
        .map((r) => r.path)
        .join(", ")
        .slice(0, 200),
      detail: `${rulesInState + rulesAdded} rules and no functional requirement recorded`,
    });
  }
  return out;
}

/** What the engine does with facts that stayed rejected after a repair attempt or without one. */
export function salvageRejected(rejected: SpecFact[]): SpecFact[] {
  return rejected.map((f) => ({
    ...f,
    section: "open_questions",
    path: `${f.section}.${f.path}`.slice(0, 120),
  }));
}

import {
  SOLUTION_CLASSES,
  type DepartmentComparison,
  type DepartmentRow,
  type SolutionClass,
} from "@aidp/shared";
import type { AnalysisFact } from "./pipeline.js";

/** An opportunity as the comparison needs it: its members, its class, its title. */
export interface ComparableOpportunity {
  clusterKey: string;
  title: string;
  solutionClass: SolutionClass;
  factIds: readonly string[];
}

const TOP = 3;
const PER_WEEK: Record<string, number> = { hourly: 40, daily: 5, weekly: 1, monthly: 0.25, rarely: 0.05 };

/** Casefolded, whitespace-collapsed department name, so "IT", " it " and "It" are one department. */
export function normalizeDepartment(raw: string | undefined): string {
  return (raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

interface Group {
  key: string; // normalized; "" is the unspecified group
  casings: Map<string, number>;
  facts: AnalysisFact[];
  participants: Set<string>;
}

/**
 * Department comparison under the anonymity rule (FR-17, D-203).
 *
 * - A department is eligible when at least `k` distinct participants stand behind it. Participants
 *   are counted, not facts: one talkative person is still one person.
 * - Departments below `k` are never named. They are pooled into one "Other" row only when the pool
 *   itself reaches `k` participants; otherwise they are left out. No total is returned, so nobody
 *   can subtract the rows from it to size a group that was left out.
 * - People who gave no department are one group, "Unspecified", and follow the same rule.
 * - The comparison is shown only when at least two rows result; one row compares nothing.
 *
 * Pure: no I/O, so the rule is proved against random distributions in a unit test.
 */
export function compareDepartments(input: {
  facts: readonly AnalysisFact[];
  opportunities: readonly ComparableOpportunity[];
  k: number;
  enabled: boolean;
}): DepartmentComparison {
  const k = Math.max(1, Math.floor(input.k));
  if (!input.enabled) return { shown: false, k, reason: "disabled", departments: [], belowK: 0 };

  const groups = new Map<string, Group>();
  for (const f of input.facts) {
    const key = normalizeDepartment(f.department);
    let g = groups.get(key);
    if (!g) {
      g = { key, casings: new Map(), facts: [], participants: new Set() };
      groups.set(key, g);
    }
    const shown = (f.department ?? "").replace(/\s+/g, " ").trim();
    if (shown) g.casings.set(shown, (g.casings.get(shown) ?? 0) + 1);
    g.facts.push(f);
    g.participants.add(f.participantKey);
  }
  const named = [...groups.values()].filter((g) => g.key !== "");
  if (named.length === 0) return { shown: false, k, reason: "no_departments", departments: [], belowK: 0 };

  const eligible: Group[] = [];
  const small: Group[] = [];
  for (const g of groups.values()) (g.participants.size >= k ? eligible : small).push(g);

  const rows: DepartmentRow[] = eligible
    .sort((a, b) => b.participants.size - a.participants.size || a.key.localeCompare(b.key))
    .map((g) => row(g, input.opportunities, g.key === "" ? "unspecified" : "department", nameOf(g), k));

  // Pool the small ones. The unspecified group, when small, joins the pool like any other.
  const pool = pooled(small);
  if (pool && pool.participants.size >= k) rows.push(row(pool, input.opportunities, "other", null, k));
  // How many names are being withheld, not how many people stand behind them.
  const belowK = small.filter((g) => g.key !== "").length;
  if (rows.length < 2) return { shown: false, k, reason: "too_few_eligible", departments: [], belowK };
  return { shown: true, k, departments: rows, belowK };
}

function nameOf(g: Group): string | null {
  if (g.key === "") return null;
  // The most common original casing; ties to the alphabetically first, so it is stable.
  return [...g.casings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? g.key;
}

function pooled(groups: readonly Group[]): Group | undefined {
  if (groups.length === 0) return undefined;
  const out: Group = { key: "\u0000other", casings: new Map(), facts: [], participants: new Set() };
  for (const g of groups) {
    out.facts.push(...g.facts);
    for (const p of g.participants) out.participants.add(p);
  }
  return out;
}

function row(
  g: Group,
  opportunities: readonly ComparableOpportunity[],
  kind: DepartmentRow["kind"],
  name: string | null,
  k: number,
): DepartmentRow {
  const ids = new Set(g.facts.map((f) => f.id));
  const byFact = new Map(g.facts.map((f) => [f.id, f.participantKey]));
  let minutes = 0;
  for (const f of g.facts) {
    if (f.fact.kind === "task") minutes += f.fact.minutesPerOccurrence * (PER_WEEK[f.fact.frequency] ?? 1);
  }
  const total = g.participants.size;
  const mentions: { op: ComparableOpportunity; people: Set<string> }[] = [];
  const byClass = new Map<SolutionClass, Set<string>>();
  for (const op of opportunities) {
    const people = new Set<string>();
    for (const id of op.factIds) {
      const who = ids.has(id) ? byFact.get(id) : undefined;
      if (who !== undefined) people.add(who);
    }
    if (people.size === 0) continue;
    const seen = byClass.get(op.solutionClass) ?? new Set<string>();
    for (const p of people) seen.add(p);
    byClass.set(op.solutionClass, seen);
    // A cell is a department-by-opportunity breakdown, so it needs k people of its own.
    if (people.size >= k) mentions.push({ op, people });
  }
  const share: DepartmentRow["solutionClassShare"] = {};
  for (const c of SOLUTION_CLASSES) {
    const n = byClass.get(c)?.size ?? 0;
    if (n >= k) share[c] = round(n / total);
  }
  return {
    name,
    kind,
    participants: total,
    facts: g.facts.length,
    minutesPerWeek: Math.round(minutes),
    topOpportunities: mentions
      .sort((a, b) => b.people.size - a.people.size || a.op.clusterKey.localeCompare(b.op.clusterKey))
      .slice(0, TOP)
      .map((m) => ({ clusterKey: m.op.clusterKey, title: m.op.title, share: round(m.people.size / total) })),
    solutionClassShare: share,
  };
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

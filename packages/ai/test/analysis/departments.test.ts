import { SOLUTION_CLASSES, type SolutionClass } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import {
  compareDepartments,
  normalizeDepartment,
  type ComparableOpportunity,
} from "../../src/analysis/departments.js";
import type { AnalysisFact } from "../../src/analysis/pipeline.js";

let seq = 0;
/** One fact per (person, department); `people` of them. */
function people(department: string | undefined, n: number, tag: string): AnalysisFact[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${tag}-f${seq++}`,
    sessionId: `${tag}-s${i}`,
    participantKey: `${tag}-p${i}`,
    ...(department === undefined ? {} : { department }),
    fact: {
      kind: "task" as const,
      name: "Do a thing",
      frequency: "weekly" as const,
      minutesPerOccurrence: 60,
      tools: [],
      painScore: 3,
    },
  }));
}

const opp = (key: string, cls: SolutionClass, facts: AnalysisFact[]): ComparableOpportunity => ({
  clusterKey: key,
  title: `Opp ${key}`,
  solutionClass: cls,
  factIds: facts.map((f) => f.id),
});

describe("normalizeDepartment", () => {
  it("folds case, whitespace and unicode width", () => {
    expect(normalizeDepartment("  Customer   Service ")).toBe("customer service");
    expect(normalizeDepartment("ＩＴ")).toBe("it");
    expect(normalizeDepartment(undefined)).toBe("");
  });
});

describe("compareDepartments", () => {
  it("is off when the setting is off, whatever the data", () => {
    const f = [...people("A", 5, "a"), ...people("B", 5, "b")];
    expect(compareDepartments({ facts: f, opportunities: [], k: 3, enabled: false })).toMatchObject({
      shown: false,
      reason: "disabled",
      departments: [],
    });
  });

  it("shows two departments at exactly k and hides them at k minus one", () => {
    const at = compareDepartments({
      facts: [...people("Ward", 3, "w"), ...people("Pharmacy", 3, "p")],
      opportunities: [],
      k: 3,
      enabled: true,
    });
    expect(at.shown).toBe(true);
    expect(at.departments.map((d) => d.name).sort()).toEqual(["Pharmacy", "Ward"]);
    const under = compareDepartments({
      facts: [...people("Ward", 3, "w"), ...people("Pharmacy", 2, "p")],
      opportunities: [],
      k: 3,
      enabled: true,
    });
    expect(under).toMatchObject({ shown: false, reason: "too_few_eligible", departments: [], belowK: 1 });
  });

  it("counts people, not facts: one person with ten facts is one participant", () => {
    const ward = people("Ward", 3, "w");
    const talkative = people("Pharmacy", 1, "p").flatMap((f) =>
      Array.from({ length: 10 }, (_, i) => ({ ...f, id: `${f.id}-${i}` })),
    );
    const r = compareDepartments({ facts: [...ward, ...talkative], opportunities: [], k: 3, enabled: true });
    expect(r.shown).toBe(false);
  });

  it("pools small departments into Other only when the pool reaches k", () => {
    const facts = [
      ...people("Ward", 4, "w"),
      ...people("Pharmacy", 4, "p"),
      ...people("Lab", 2, "l"),
      ...people("Kitchen", 1, "k"),
    ];
    const r = compareDepartments({ facts, opportunities: [], k: 3, enabled: true });
    expect(r.shown).toBe(true);
    const other = r.departments.find((d) => d.kind === "other");
    expect(other).toMatchObject({ participants: 3, name: null });
    expect(r.belowK).toBe(2);
    expect(JSON.stringify(r)).not.toMatch(/Lab|Kitchen/);

    const small = compareDepartments({
      facts: [...people("Ward", 4, "w"), ...people("Pharmacy", 4, "p"), ...people("Lab", 2, "l")],
      opportunities: [],
      k: 3,
      enabled: true,
    });
    expect(small.departments.find((d) => d.kind === "other")).toBeUndefined();
    expect(JSON.stringify(small)).not.toContain("Lab");
    expect(small.belowK).toBe(1);
  });

  it("treats case and spacing variants as one department and shows the commonest spelling", () => {
    const facts = [
      ...people("customer service", 1, "c1"),
      ...people("Customer Service", 1, "c2"),
      ...people(" Customer  Service", 1, "c3"),
      ...people("Customer Service", 1, "c4"),
      ...people("IT", 3, "it"),
    ];
    const r = compareDepartments({ facts, opportunities: [], k: 3, enabled: true });
    const cs = r.departments.find((d) => d.participants === 4);
    expect(cs?.name).toBe("Customer Service");
    expect(r.departments).toHaveLength(2);
  });

  it("explains an empty comparison when nobody gave a department", () => {
    const r = compareDepartments({ facts: people(undefined, 8, "x"), opportunities: [], k: 3, enabled: true });
    expect(r).toMatchObject({ shown: false, reason: "no_departments" });
  });

  it("lists Unspecified only when it is large enough on its own", () => {
    const r = compareDepartments({
      facts: [...people("Ward", 3, "w"), ...people("Pharmacy", 3, "p"), ...people(undefined, 3, "u")],
      opportunities: [],
      k: 3,
      enabled: true,
    });
    expect(r.departments.find((d) => d.kind === "unspecified")).toMatchObject({ participants: 3 });
    const few = compareDepartments({
      facts: [...people("Ward", 3, "w"), ...people("Pharmacy", 3, "p"), ...people(undefined, 2, "u")],
      opportunities: [],
      k: 3,
      enabled: true,
    });
    expect(few.departments.find((d) => d.kind === "unspecified")).toBeUndefined();
  });

  it("withholds an opportunity or class cell that fewer than k of the department's people stand behind", () => {
    const ward = people("Ward", 4, "w");
    const pharmacy = people("Pharmacy", 4, "p");
    const opportunities = [
      opp("shared", "automation", [...ward, ...pharmacy]),
      // Two people of the ward: below k = 3, so it must not be named for the ward.
      opp("two", "software", ward.slice(0, 2)),
    ];
    const r = compareDepartments({ facts: [...ward, ...pharmacy], opportunities, k: 3, enabled: true });
    const w = r.departments.find((d) => d.name === "Ward");
    expect(w?.topOpportunities.map((t) => t.clusterKey)).toEqual(["shared"]);
    expect(w?.solutionClassShare.automation).toBe(1);
    expect(w?.solutionClassShare.software).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("Opp two");
  });

  it("never names a group of fewer than k participants, over many random distributions", () => {
    // A seeded generator, so a failure reproduces: 600 random campaigns.
    let state = 20260101;
    const rand = (): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const names = ["Ward", "Pharmacy", "Lab", "Kitchen", "IT", "Finance", "Porters", "Admissions"];
    for (let trial = 0; trial < 600; trial++) {
      const k = 1 + Math.floor(rand() * 5);
      const facts: AnalysisFact[] = [];
      const sizes = new Map<string, number>();
      for (const name of names) {
        if (rand() < 0.3) continue;
        const n = Math.floor(rand() * 7);
        if (n === 0) continue;
        sizes.set(name, n);
        facts.push(...people(name, n, `t${trial}${name}`));
      }
      const unspecified = rand() < 0.5 ? Math.floor(rand() * 5) : 0;
      if (unspecified) facts.push(...people(undefined, unspecified, `t${trial}u`));
      const opportunities = facts.length
        ? [opp("o1", SOLUTION_CLASSES[Math.floor(rand() * 5)] ?? "ai", facts.filter(() => rand() < 0.6))]
        : [];
      const r = compareDepartments({ facts, opportunities, k, enabled: true });
      const text = JSON.stringify(r);
      for (const [name, n] of sizes) if (n < k) expect(text, `trial ${trial}: ${name} (${n} < ${k})`).not.toContain(`"${name}"`);
      for (const d of r.departments) {
        expect(d.participants, `trial ${trial}`).toBeGreaterThanOrEqual(k);
        for (const share of Object.values(d.solutionClassShare)) expect(share).toBeLessThanOrEqual(1);
      }
      if (r.shown) expect(r.departments.length).toBeGreaterThanOrEqual(2);
      else expect(r.departments).toEqual([]);
      // No group's size can be recovered from a total, because none is returned.
      expect(Object.keys(r).sort()).toEqual(
        ["belowK", "departments", "k", "shown", ...(r.reason ? ["reason"] : [])].sort(),
      );
    }
  });
});

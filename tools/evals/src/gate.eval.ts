import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { BASELINE_FILE, loadFixtures } from "./fixtures.js";
import { gate, type GateRule } from "./metrics.js";
import { replayFixture } from "./replay.js";

/**
 * The replay gate (engineering plan 3.4, D-192). Every fixture is replayed through the real engine
 * with the recorded model; the numbers are compared with `baselines/replay.json`. Exact metrics
 * must match, ratio metrics may not fall (or, for failure rates, rise) by more than the tolerance.
 * Improving a number does not fail, but the baseline has to be raised in the same change:
 *
 *   UPDATE_EVAL_BASELINE=1 pnpm --filter @aidp/evals test
 *
 * The diff of baselines/replay.json is then the visible record of the change.
 */
const RULES: Record<string, GateRule["mode"]> = {
  ended: "equal",
  turnsUsed: "equal",
  coveragePass: "equal",
  coveredAreas: "min",
  contractFailureRate: "max",
  markerMissRate: "equal",
  factRecall: "min",
  requirementCapture: "min",
  requirementsMisfiled: "max",
  scopeWrong: "max",
  frIdIntegrity: "equal",
  specCompleteness: "min",
  issuePrecision: "min",
  issueRecall: "min",
};

type Baseline = Record<string, Record<string, number | boolean>>;

const fixtures = loadFixtures();
const update = process.env.UPDATE_EVAL_BASELINE === "1";

describe("replay fixtures (D-192)", () => {
  it("ships at least six requirements and six discovery fixtures of 60 turns", () => {
    const by = (k: string) => fixtures.filter((f) => f.templateKey === k);
    expect(by("requirements_discovery").length).toBeGreaterThanOrEqual(6);
    expect(by("opportunity_discovery").length).toBeGreaterThanOrEqual(6);
    for (const f of fixtures) expect(f.turns, f.id).toHaveLength(60);
    const personas = new Set(fixtures.map((f) => f.persona));
    for (const p of ["cooperative", "terse", "off_topic", "contradictory", "technical", "nontechnical"])
      expect(personas.has(p as never), p).toBe(true);
  });

  it("gold requirements are introduced within the turns an interview reaches", () => {
    for (const f of fixtures)
      for (const g of f.goldRequirements) expect(g.introducedAtTurn, `${f.id} ${g.id}`).toBeGreaterThan(0);
  });

  const outcomes = new Map<string, Awaited<ReturnType<typeof replayFixture>>>();
  it.each(fixtures.map((f) => [f.id, f] as const))("replays %s", async (_id, fixture) => {
    const outcome = await replayFixture(fixture);
    outcomes.set(fixture.id, outcome);
    // What every fixture must satisfy regardless of the baseline.
    expect(outcome.ended, `${fixture.id} ended`).toBe(true);
    expect(outcome.metrics.contractFailureRate, `${fixture.id} turn contract failures`).toBe(0);
    if (fixture.templateKey === "requirements_discovery") {
      expect(outcome.metrics.requirementsMisfiled, `${fixture.id} requirements filed under rules`).toBe(0);
      expect(outcome.metrics.frIdIntegrity, `${fixture.id} FR ids`).toBe(true);
    }
  });

  it("matches the committed baseline", () => {
    expect(outcomes.size).toBe(fixtures.length);
    const fresh: Baseline = Object.fromEntries([...outcomes].map(([id, o]) => [id, o.metrics]));
    if (update) {
      mkdirSync(dirname(BASELINE_FILE), { recursive: true });
      writeFileSync(BASELINE_FILE, `${JSON.stringify(fresh, null, 2)}\n`);
      return;
    }
    expect(existsSync(BASELINE_FILE), "tools/evals/baselines/replay.json is missing").toBe(true);
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
    const regressions: string[] = [];
    for (const [id, metrics] of Object.entries(fresh)) {
      const base = baseline[id];
      if (!base) {
        regressions.push(`${id}: no baseline`);
        continue;
      }
      const applicable = Object.fromEntries(Object.entries(RULES).filter(([k]) => k in base || k in metrics));
      for (const line of gate(metrics, base, applicable)) regressions.push(`${id}: ${line}`);
    }
    expect(regressions, regressions.join("\n")).toEqual([]);
  });
});

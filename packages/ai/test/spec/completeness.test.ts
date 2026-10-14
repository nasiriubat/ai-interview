import { SessionStateSchema, type Fact } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { checkCompleteness, completenessFinding } from "../../src/spec/completeness.js";
import { detectIssues, shouldScanIssues } from "../../src/spec/issues.js";
import { resolvePolicy } from "../../src/spec/policy.js";
import { ScriptedCaller, template } from "../engine/helpers.js";

const spec = (section: string, path: string, value: unknown): Fact => ({
  kind: "spec_field",
  section,
  path,
  value,
  source: "user",
});
const fr = (n: number, acceptance: string[] = ["works"]): Fact =>
  spec("functional", `FR-${n}`, { title: `Cap ${n}`, scope: "mvp", acceptance });

const reqTemplate = template({
  outputs: ["spec_field"],
  issueDetection: { enabled: true, everyTurns: 5, aggressiveness: "standard", mvpChallenge: false },
});
const covered = {
  role: { status: "covered" },
  daily: { status: "covered" },
  problems: { status: "covered" },
};
const logger = { warn: () => undefined, info: () => undefined };

describe("requirements completeness (D-191)", () => {
  const config = reqTemplate.completeness;

  it("lists missing sections, too few requirements and requirements without acceptance", () => {
    const empty = checkCompleteness({ facts: [] }, config);
    expect(empty.ok).toBe(false);
    expect(empty.requirementCount).toBe(0);
    expect(empty.gaps.map((g) => `${g.kind}:${g.section}`)).toEqual([
      "requirements:functional",
      "section:overview",
      "section:users",
    ]);

    const one = checkCompleteness(
      { facts: [fr(1, []), spec("overview", "problem", "p"), spec("users", "nurse", "n")] },
      config,
    );
    expect(one.gaps.map((g) => g.kind)).toEqual(["requirements", "acceptance"]);
    expect(one.gaps[0]?.description).toContain("Only 1 functional requirement is recorded");

    const full = checkCompleteness(
      { facts: [fr(1), fr(2), fr(3), spec("overview", "p", "p"), spec("users", "n", "n")] },
      config,
    );
    expect(full).toMatchObject({ ok: true, requirementCount: 3, mvpCount: 3, gaps: [] });
  });

  it("counts an owner's edit as content for its section", () => {
    const r = checkCompleteness({ facts: [fr(1), fr(2), fr(3)] }, config, {
      overview: { markdown: "text", updatedAt: "2026-01-01" } as never,
      users: { markdown: "text", updatedAt: "2026-01-01" } as never,
    });
    expect(r.ok).toBe(true);
  });

  it("turns the most important gap into a finding the interview raises", () => {
    const f = completenessFinding(checkCompleteness({ facts: [] }, config));
    expect(f).toMatchObject({ type: "missing_decision", section: "functional", confidence: "high" });
    expect(
      completenessFinding(
        checkCompleteness({ facts: [fr(1), fr(2), fr(3)] }, { ...config, requiredSections: [] }),
      ),
    ).toBeUndefined();
  });

  it("drives a follow-up: with every area covered and one requirement, the scan is 'completeness', bounded by maxAsks", async () => {
    const policy = resolvePolicy(reqTemplate, "technical");
    const base = {
      coverage: covered,
      facts: [fr(1), spec("overview", "p", "p"), spec("users", "n", "n")],
      finalIssueScanDone: true,
      turnCount: 9,
    };
    const st = SessionStateSchema.parse(base);
    expect(shouldScanIssues(reqTemplate, st, policy, "technical")).toBe("completeness");

    // No model call: the finding is deterministic.
    const caller = new ScriptedCaller([]);
    const found = await detectIssues(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger },
      {
        companyId: "c",
        sessionId: "s",
        template: reqTemplate,
        state: st,
        path: "technical",
        policy,
        reason: "completeness",
      },
    );
    expect(caller.requests).toHaveLength(0);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "c9-1", status: "open", section: "functional" });

    // After maxAsks rounds the interview is allowed to close.
    const spent = SessionStateSchema.parse({ ...base, completenessAsks: reqTemplate.completeness.maxAsks });
    expect(shouldScanIssues(reqTemplate, spent, policy, "technical")).toBeUndefined();
    // And a complete specification is not asked again.
    const done = SessionStateSchema.parse({ ...base, facts: [...base.facts, fr(2), fr(3)] });
    expect(shouldScanIssues(reqTemplate, done, policy, "technical")).toBeUndefined();
  });

  it("scans for completeness even when nothing at all was recorded", () => {
    const policy = resolvePolicy(reqTemplate, "technical");
    const st = SessionStateSchema.parse({ coverage: covered, turnCount: 9 });
    expect(shouldScanIssues(reqTemplate, st, policy, "technical")).toBe("completeness");
  });
});

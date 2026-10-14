import type { Fact } from "@aidp/shared";
import { SessionStateSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { confirmationFinding, confirmationLines } from "../../src/spec/confirmation.js";
import { checkSpecFacts } from "../../src/spec/delta-validation.js";
import { detectIssues, shouldScanIssues } from "../../src/spec/issues.js";
import { requirementFacts } from "../../src/spec/live.js";
import { resolvePolicy } from "../../src/spec/policy.js";
import { ScriptedCaller, template } from "../engine/helpers.js";

const spec = (
  section: string,
  path: string,
  value: unknown,
  source: "user" | "default_accepted" | "recommended" = "user",
): Fact => ({
  kind: "spec_field",
  section,
  path,
  value,
  source,
});
const none = { facts: [] as Fact[] };

describe("a decision, a constraint or a question is not a functional requirement (D-242)", () => {
  it("files each where it belongs, and a capability stays functional", () => {
    const r = checkSpecFacts(
      [
        spec("functional", "FR-1", {
          title: "Nurse enters a ward note once",
          scope: "mvp",
          acceptance: ["a"],
        }),
        spec("functional", "FR-2", {
          title: "Should notes be kept for ten years?",
          scope: "mvp",
          acceptance: [],
        }),
        spec("functional", "FR-3", {
          title: "Retention of notes for ten years",
          scope: "mvp",
          acceptance: [],
        }),
      ],
      none,
    );
    const where = r.facts.map((f) => (f.kind === "spec_field" ? `${f.section}:${f.path}` : ""));
    expect(where[0]).toBe("functional:FR-1");
    expect(where[1]).toBe("open_questions:Should notes be kept for ten years?");
    expect(where[2]).toBe("rules:Retention of notes for ten years");
    expect(r.repaired.filter((x) => x.kind === "rerouted")).toHaveLength(2);
  });

  it("turns a tombstone into a withdrawal of the requirement it replaces", () => {
    const state = {
      facts: [spec("functional", "FR-4", { title: "Export to PDF", scope: "mvp", acceptance: ["a"] })],
    };
    const r = checkSpecFacts([spec("functional", "FR-4", { title: "Removed", scope: "mvp" })], state);
    const f = r.facts[0];
    expect(f?.kind === "spec_field" && f.path).toBe("FR-4");
    expect(f?.kind === "spec_field" && (f.value as { withdrawn?: boolean; title: string })).toMatchObject({
      title: "Export to PDF",
      withdrawn: true,
    });
    // Nothing new is filed when there was nothing to withdraw.
    expect(checkSpecFacts([spec("functional", "FR-9", { title: "Removed" })], none).facts).toHaveLength(0);
  });
});

describe("grounding: a requirement needs the participant's own words (D-243)", () => {
  const spoken = [
    "We type every ward note twice, once in Epic and once in the spreadsheet. I want to type it once.",
  ];

  it("keeps a verified quote and marks nothing", () => {
    const r = checkSpecFacts(
      [
        spec("functional", "FR-1", {
          title: "Nurse types a note once",
          scope: "mvp",
          acceptance: ["a"],
          evidence: "I want to type it once",
        }),
      ],
      none,
      { producesSpec: true, spoken },
    );
    const v = r.facts[0]?.kind === "spec_field" ? (r.facts[0].value as Record<string, unknown>) : {};
    expect(v.evidence).toBe("I want to type it once");
    expect(v.needsConfirmation).toBeUndefined();
  });

  it("flags a requirement with no quote, or with a quote the participant never said", () => {
    const r = checkSpecFacts(
      [
        spec("functional", "FR-1", { title: "Export to PDF", scope: "mvp", acceptance: [] }),
        spec("functional", "FR-2", {
          title: "Audit every read",
          scope: "mvp",
          acceptance: [],
          evidence: "the auditors will want every read logged for seven years",
        }),
      ],
      none,
      { producesSpec: true, spoken },
    );
    for (const f of r.facts) {
      const v = f.kind === "spec_field" ? (f.value as Record<string, unknown>) : {};
      expect(v.needsConfirmation).toBe(true);
      expect(v.evidence).toBeUndefined();
    }
    expect(r.repaired.filter((x) => x.kind === "ungrounded")).toHaveLength(2);
  });

  it("does not flag what the owner accepted as a default, and keeps earlier evidence on a re-record", () => {
    const state = {
      facts: [
        spec("functional", "FR-1", {
          title: "Type a note once",
          scope: "mvp",
          acceptance: ["a"],
          evidence: "I want to type it once",
        }),
      ],
    };
    const r = checkSpecFacts(
      [
        spec("functional", "FR-1", {
          title: "Type a note once",
          scope: "future",
          acceptance: ["a"],
          reason: "later",
        }),
        spec(
          "functional",
          "FR-2",
          { title: "Autosave drafts", scope: "mvp", acceptance: [] },
          "default_accepted",
        ),
      ],
      state,
      { producesSpec: true, spoken },
    );
    const values = r.facts.map((f) => (f.kind === "spec_field" ? (f.value as Record<string, unknown>) : {}));
    expect(values[0]?.evidence).toBe("I want to type it once");
    expect(values[0]?.needsConfirmation).toBeUndefined();
    expect(values[1]?.needsConfirmation).toBeUndefined();
  });

  it("checks nothing when no spoken text is given", () => {
    const r = checkSpecFacts([spec("functional", "FR-1", { title: "Export", scope: "mvp" })], none);
    const v = r.facts[0]?.kind === "spec_field" ? (r.facts[0].value as Record<string, unknown>) : {};
    expect(v.needsConfirmation).toBeUndefined();
  });
});

describe("confirming the list back to the owner (D-244)", () => {
  const facts: Fact[] = [
    spec("functional", "FR-1", {
      title: "Nurse types a note once",
      scope: "mvp",
      acceptance: ["a"],
      evidence: "type it once",
    }),
    spec("functional", "FR-2", { title: "Nurse types a note once", scope: "mvp", acceptance: ["b"] }),
    spec("functional", "FR-3", {
      title: "Charge nurse exports the handover to PDF",
      scope: "future",
      acceptance: [],
      needsConfirmation: true,
    }),
    spec("functional", "FR-4", { title: "Old idea", scope: "mvp", withdrawn: true }),
  ];

  it("is a compact numbered list without duplicates or withdrawn items, with the inferred one marked", () => {
    const lines = confirmationLines({ facts });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("1. Nurse types a note once (FR-1; first version)");
    expect(lines[1]).toContain(
      "2. Charge nurse exports the handover to PDF (FR-3; later; I inferred this, is it right?)",
    );
    const finding = confirmationFinding({ facts });
    expect(finding?.type).toBe("ambiguity");
    expect(finding?.description).toContain("Is anything on this list wrong or missing?");
  });

  it(
    "raises once through the finding flow when the areas are done, and at " + "the owner's done",
    async () => {
      const t = template({
        outputs: ["spec_field"],
        completeness: { minRequirements: 0, requiredSections: [], requireAcceptance: false },
        issueDetection: { enabled: true, everyTurns: 5, aggressiveness: "standard", mvpChallenge: true },
      });
      const policy = resolvePolicy(t, undefined, undefined);
      const base = SessionStateSchema.parse({
        facts,
        turnCount: 6,
        finalIssueScanDone: true,
        contextAnswers: {},
        coverage: Object.fromEntries(
          t.coverageAreas.map((a) => [
            a.key,
            { status: "covered", known: "", missing: "", followUpsUsed: 0 },
          ]),
        ),
        phase: "areas",
      });
      expect(shouldScanIssues(t, base, policy)).toBe("confirm");
      expect(shouldScanIssues(t, { ...base, requirementsConfirmAsked: true }, policy)).toBeUndefined();
      // Not complete, not near the end: nothing, until the owner presses done.
      const open = { ...base, finalIssueScanDone: false, coverage: {} };
      expect(shouldScanIssues(t, open, policy)).not.toBe("confirm");
      expect(shouldScanIssues(t, { ...open, finishRequested: true }, policy)).toBe("confirm");
      expect(shouldScanIssues(t, open, policy, undefined, { nearEnd: true })).toBe("confirm");

      const found = await detectIssues(
        {
          caller: new ScriptedCaller([]).asCaller(),
          prompts: new ShippedPromptSource(),
          logger: { warn: () => undefined, info: () => undefined },
        },
        { companyId: "c", sessionId: "s", template: t, state: base, policy, reason: "confirm" },
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.description).toContain("1. Nurse types a note once");
    },
  );

  it("does not count a withdrawn requirement anywhere else either", () => {
    const state = SessionStateSchema.parse({ facts });
    expect(requirementFacts(state).map((f) => f.path)).toEqual(["FR-1", "FR-2", "FR-3"]);
  });
});

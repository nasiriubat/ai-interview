import { SessionStateSchema, type Fact } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { seedStateFromHandoff } from "../../src/spec/handoff.js";
import { mvpItems, nextMvpItem, renderLiveSpec, renderSpecState, renderValue } from "../../src/spec/live.js";
import { template } from "../engine/helpers.js";

const field = (
  section: string,
  path: string,
  value: unknown,
  source: Fact["kind"] extends never ? never : "user" | "recommended" | "handoff" = "user",
): Fact => ({
  kind: "spec_field",
  section,
  path,
  value,
  source,
});

const state = SessionStateSchema.parse({
  contextAnswers: { hosting: "cloud" },
  facts: [
    field("problem", "statement", "Nurses chart twice"),
    field("functional", "FR-1", { title: "Single entry charting", scope: "mvp", acceptance: ["one form"] }),
    field("functional", "FR-2", { title: "Export to Excel", scope: "future", reason: "not needed for v1" }),
    field("functional", "FR-3", { title: "Lab result import" }),
    field("Technical Recommended", "stack", { choice: "Next.js", reason: "team knows it" }, "recommended"),
    field("weird_section", "x", ["a", "b"]),
  ],
  findings: [
    {
      id: "f1",
      type: "ambiguity",
      section: "functional",
      description: "d",
      resolution: "r",
      default: "x",
      status: "open",
    },
    {
      id: "f2",
      type: "contradiction",
      section: "data",
      description: "d2",
      resolution: "r",
      default: "x",
      status: "accepted",
    },
  ],
});

describe("live spec", () => {
  it("groups fields by canonical section, keeps template order, appends unknown sections and marks edits authoritative", () => {
    const live = renderLiveSpec({
      title: "Charting",
      path: "nontechnical",
      state,
      edits: { users: { markdown: "Owner wrote this", editedAt: "2026-09-11T00:00:00Z", editedBy: "u1" } },
    });
    const keys = live.sections.map((s) => s.key);
    expect(keys.slice(0, 3)).toEqual(["overview", "users", "stories"]);
    expect(keys.at(-1)).toBe("weird_section");
    const overview = live.sections.find((s) => s.key === "overview");
    expect(overview?.status).toBe("draft");
    expect(overview?.markdown).toContain("**statement**: Nurses chart twice");
    const technical = live.sections.find((s) => s.key === "technical");
    expect(technical?.fields).toHaveLength(1);
    expect(technical?.markdown).toContain("_(recommended)_");
    const functional = live.sections.find((s) => s.key === "functional");
    expect(functional?.markdown).toContain("- **FR-1** (mvp): Single entry charting");
    expect(functional?.markdown).toContain("  - Acceptance: one form");
    expect(functional?.markdown).toContain("- **FR-2** (future): Export to Excel");
    const users = live.sections.find((s) => s.key === "users");
    expect(users?.status).toBe("edited");
    expect(users?.markdown).toBe("Owner wrote this");
    expect(live.sections.find((s) => s.key === "weird_section")?.title).toBe("Weird section");
    expect(live.stats).toEqual({ fields: 6, sectionsWithContent: 5, openFindings: 1 });
    expect(live.context).toEqual({ hosting: "cloud" });
  });

  it("lists MVP items (untagged counts as mvp) and walks them in order", () => {
    expect(mvpItems(state).map((i) => i.path)).toEqual(["FR-1", "FR-3"]);
    expect(
      nextMvpItem({ ...state, mvpChallenge: { started: true, done: false, asked: ["FR-1"] } })?.path,
    ).toBe("FR-3");
    expect(
      nextMvpItem({ ...state, mvpChallenge: { started: true, done: false, asked: ["FR-1", "FR-3"] } }),
    ).toBeUndefined();
  });

  it("renders values compactly and the spec state for prompts without the transcript", () => {
    expect(renderValue({ choice: "Next.js", alternatives: ["Remix", "Rails"], empty: "" })).toBe(
      "choice: Next.js; alternatives: Remix, Rails",
    );
    const text = renderSpecState(state, "nontechnical", {
      rules: { markdown: "R1", editedAt: "", editedBy: null },
    });
    expect(text).toContain("Path: nontechnical");
    expect(text).toContain("## functional: Functional requirements");
    expect(text).toContain("## rules: Business rules (edited by the owner; authoritative)");
    expect(text).toContain("Findings already settled");
    expect(text).toContain("[contradiction] data: d2 → accepted");
    expect(text).not.toContain("[ambiguity]");
  });

  it("seeds a session from a discovery hand-off and marks the informed areas partial", () => {
    const t = template({
      coverageAreas: [
        { key: "problem", name: "Problem", description: "P", doneWhen: "known" },
        { key: "users", name: "Users", description: "U", doneWhen: "known" },
        { key: "stories", name: "Stories", description: "S", doneWhen: "known" },
      ],
      outputs: ["spec_field"],
    });
    const s = seedStateFromHandoff(
      undefined,
      {
        sourceOpportunityId: "o1",
        problem: "Double charting",
        affectedUsers: ["Nurse", "Ward clerk"],
        existingProcess: ["chart", "copy to excel"],
        tools: ["Excel"],
        constraints: "GDPR",
        expectedBenefit: "45 minutes per shift",
        evidenceQuotes: ["I type everything twice"],
      },
      t,
    );
    expect(s.coverage.problem?.status).toBe("partial");
    expect(s.coverage.users?.status).toBe("partial");
    expect(s.coverage.stories).toBeUndefined();
    const facts = s.facts.filter((f) => f.kind === "spec_field");
    expect(facts.every((f) => f.source === "handoff")).toBe(true);
    expect(facts.map((f) => `${f.section}/${f.path}`)).toEqual([
      "overview/problem",
      "overview/expected_benefit",
      "overview/existing_process",
      "users/affected",
      "integrations/existing_tools",
      "rules/constraints",
      "overview/evidence",
    ]);
    const live = renderLiveSpec({ title: "t", path: null, state: s, edits: {} });
    expect(live.sections.find((x) => x.key === "overview")?.markdown).toContain("_(from discovery)_");
  });
});

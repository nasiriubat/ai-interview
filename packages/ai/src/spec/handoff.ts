import type { Fact, Handoff, InterviewTemplate, SessionState } from "@aidp/shared";
import { SessionStateSchema } from "@aidp/shared";
import { mergeFacts } from "../engine/state.js";

const field = (section: string, path: string, value: unknown): Fact => ({
  kind: "spec_field",
  section,
  path,
  value,
  source: "handoff",
});

/**
 * Seeds a requirements session from a discovery hand-off (FR-66): pre-filled spec fields
 * marked `handoff`, and the areas they inform marked partial so the engine asks only what
 * is missing.
 */
export function seedStateFromHandoff(
  state: SessionState | undefined,
  handoff: Handoff,
  template: InterviewTemplate,
): SessionState {
  const base = SessionStateSchema.parse(state ?? {});
  const facts: Fact[] = [];
  if (handoff.problem) facts.push(field("overview", "problem", handoff.problem));
  if (handoff.expectedBenefit) facts.push(field("overview", "expected_benefit", handoff.expectedBenefit));
  if (handoff.existingProcess.length)
    facts.push(field("overview", "existing_process", handoff.existingProcess));
  if (handoff.affectedUsers.length)
    facts.push(
      field(
        "users",
        "affected",
        handoff.affectedUsers.map((r) => ({ role: r })),
      ),
    );
  if (handoff.tools.length) facts.push(field("integrations", "existing_tools", handoff.tools));
  if (handoff.constraints) facts.push(field("rules", "constraints", handoff.constraints));
  if (handoff.evidenceQuotes.length)
    facts.push(field("overview", "evidence", handoff.evidenceQuotes.slice(0, 5)));

  const known = (what: string): string => `From discovery hand-off: ${what}`;
  const coverage = { ...base.coverage };
  const mark = (areaKey: string, what: string, missing: string): void => {
    if (!template.coverageAreas.some((a) => a.key === areaKey)) return;
    const prev = coverage[areaKey];
    if (prev && prev.status !== "untouched") return;
    coverage[areaKey] = { status: "partial", known: known(what), missing, followUpsUsed: 0 };
  };
  if (handoff.problem)
    mark("problem", handoff.problem.slice(0, 200), "confirm the problem statement and success measure");
  if (handoff.affectedUsers.length)
    mark("users", handoff.affectedUsers.join(", "), "roles beyond those interviewed, and who administers");
  if (handoff.tools.length)
    mark("integrations", handoff.tools.join(", "), "which systems must be integrated and how");

  return { ...base, coverage, facts: mergeFacts(base.facts, facts) };
}

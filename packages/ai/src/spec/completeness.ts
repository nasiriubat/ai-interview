import {
  normalizeSectionKey,
  SPEC_SECTION_TITLES,
  type Completeness,
  type DetectedFinding,
  type SessionState,
  type SpecEdits,
} from "@aidp/shared";
import { asObject, requirementFacts, scopeOf, specFacts } from "./live.js";

/**
 * The deterministic completeness check of a requirements specification (D-191). It reads only the
 * recorded facts, so it runs without a model call during the interview and again at generation,
 * and the interview and the generator agree on what "missing" means.
 */

export type GapKind = "section" | "requirements" | "acceptance";

export interface CompletenessGap {
  kind: GapKind;
  section: string;
  description: string;
  /** What the interviewer is steered toward. */
  resolution: string;
  paths?: string[];
}

export interface CompletenessReport {
  ok: boolean;
  requirementCount: number;
  mvpCount: number;
  gaps: CompletenessGap[];
}

const sectionName = (key: string): string =>
  (SPEC_SECTION_TITLES as Record<string, string | undefined>)[key] ?? key;

export function checkCompleteness(
  state: Pick<SessionState, "facts">,
  config: Completeness,
  edits: SpecEdits = {},
): CompletenessReport {
  const gaps: CompletenessGap[] = [];
  const full = state as SessionState;
  const reqs = requirementFacts(full);
  const filled = new Set(specFacts(full).map((f) => f.sectionKey));
  for (const [k, e] of Object.entries(edits)) if (e.markdown.trim()) filled.add(k);

  if (reqs.length < config.minRequirements) {
    gaps.push({
      kind: "requirements",
      section: "functional",
      description:
        reqs.length === 0
          ? "No functional requirement has been recorded."
          : `Only ${reqs.length} functional requirement${reqs.length === 1 ? " is" : "s are"} recorded; a buildable specification needs at least ${config.minRequirements}.`,
      resolution:
        "Ask what else the product must let people do, one thing at a time, and record each as its own requirement.",
    });
  }
  for (const key of config.requiredSections) {
    const canonical = normalizeSectionKey(key) ?? key;
    if (canonical === "functional") continue; // reported as requirements above
    if (!filled.has(canonical))
      gaps.push({
        kind: "section",
        section: canonical,
        description: `Nothing is recorded for "${sectionName(canonical)}".`,
        resolution: `Ask the one question that settles ${sectionName(canonical).toLowerCase()}.`,
      });
  }
  const noAcceptance = reqs
    .filter((f) => {
      const a = asObject(f.value).acceptance;
      return !Array.isArray(a) || a.filter((x) => typeof x === "string" && x.trim() !== "").length === 0;
    })
    .map((f) => f.path);
  if (config.requireAcceptance && reqs.length > 0 && noAcceptance.length > 0)
    gaps.push({
      kind: "acceptance",
      section: "functional",
      description: `${noAcceptance.length} requirement${noAcceptance.length === 1 ? " has" : "s have"} no acceptance criterion (${noAcceptance.slice(0, 5).join(", ")}).`,
      resolution:
        "Ask how the owner would know one of them works, and record that as its acceptance criterion.",
      paths: noAcceptance,
    });

  return {
    ok: gaps.length === 0,
    requirementCount: reqs.length,
    mvpCount: reqs.filter((f) => scopeOf(f.value) === "mvp").length,
    gaps,
  };
}

/** The most important gap as a finding in the shape the issue-detection pass produces. */
export function completenessFinding(report: CompletenessReport): DetectedFinding | undefined {
  const gap = report.gaps[0];
  if (!gap) return undefined;
  return {
    type: "missing_decision",
    section: gap.section,
    ...(gap.paths?.[0] ? { path: gap.paths[0] } : {}),
    description: gap.description,
    resolution: gap.resolution,
    default: gap.kind === "acceptance" ? "Take the obvious behavior as the acceptance criterion." : "",
    confidence: "high",
  };
}

/** One line per gap, for logs and the failure reason of a generation. */
export function describeGaps(report: CompletenessReport): string {
  return report.gaps.map((g) => g.description).join(" ");
}

import { containsQuote } from "./pure.js";

/** The slice of the analysis and spec payloads the checks read. Extra fields are ignored. */
export interface OpportunityView {
  id: string;
  clusterKey: string;
  title: string;
  summary: string;
  solutionClass: string;
  rankScore: number;
  status: string;
  stats: { participants: number; facts: number; roles: string[]; departments: string[]; quotes: string[] };
  evidence: { factId: string; snippet: string; anonymized: boolean }[];
  whyNotAi?: string;
  dataNeeded: string[];
  risks: string[];
}

export interface KAnonymityFinding {
  opportunity: string;
  participants: number;
  problem: string;
}

/**
 * k-anonymity as the contract states it: below k participants, a cluster exposes no quotes, no
 * role or department breakdown, and no evidence snippet that is a participant's own words.
 */
export function checkKAnonymity(
  opportunities: OpportunityView[],
  k: number,
  quotesByFactId: Map<string, string>,
  reportMarkdown: string,
): KAnonymityFinding[] {
  const findings: KAnonymityFinding[] = [];
  for (const o of opportunities) {
    if (o.stats.participants >= k) continue;
    const label = `${o.title} (${o.clusterKey})`;
    if (o.stats.quotes.length > 0)
      findings.push({
        opportunity: label,
        participants: o.stats.participants,
        problem: `${o.stats.quotes.length} quote(s) in stats`,
      });
    if (o.stats.roles.length > 0 || o.stats.departments.length > 0)
      findings.push({
        opportunity: label,
        participants: o.stats.participants,
        problem: "role or department breakdown shown",
      });
    for (const e of o.evidence) {
      const original = quotesByFactId.get(e.factId);
      if (original && containsQuote(e.snippet, original))
        findings.push({
          opportunity: label,
          participants: o.stats.participants,
          problem: `evidence snippet repeats a verbatim quote (fact ${e.factId})`,
        });
      if (original && containsQuote(reportMarkdown, original))
        findings.push({
          opportunity: label,
          participants: o.stats.participants,
          problem: `report repeats a verbatim quote (fact ${e.factId})`,
        });
    }
  }
  return findings;
}

/** Names that must never appear in an analysis output or report. Whole-word, case-insensitive. */
export function leakedNames(text: string, names: string[]): string[] {
  return names.filter((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

export const REPORT_HEADINGS: Record<string, RegExp> = {
  executive_summary: /^##\s+Executive summary/im,
  participation: /^##\s+Participation/im,
  work_map: /^##\s+Work map/im,
  opportunities: /^##\s+Opportunities/im,
  quick_wins_vs_strategic: /^##\s+Quick wins/im,
  not_ai: /^##\s+Where AI is not/im,
  next_steps: /^##\s+Recommended next steps/im,
};

export function reportSectionsPresent(markdown: string): Record<string, boolean> {
  return Object.fromEntries(Object.entries(REPORT_HEADINGS).map(([k, re]) => [k, re.test(markdown)]));
}

// ---------------------------------------------------------------------------------------------
// Specification
// ---------------------------------------------------------------------------------------------

export const SPEC_SECTION_KEYS = [
  "overview",
  "users",
  "stories",
  "functional",
  "rules",
  "technical",
  "data",
  "integrations",
  "security",
  "nfr",
  "admin",
  "mvp",
  "future",
  "phases",
  "open_questions",
  "diagrams",
] as const;

export interface SpecDocumentView {
  title: string;
  sections: { key: string; title: string; markdown: string; source: string }[];
  requirements: {
    id: string;
    title: string;
    scope: string;
    acceptance: string[];
    tracedTo?: string | undefined;
  }[];
  phases: {
    key: string;
    name: string;
    tasks: { title: string; acceptance: string[] }[];
    acceptance: string[];
  }[];
  openQuestions: { question: string; defaultTaken?: string }[];
  diagrams: { key: string; title: string; type: string; mermaid: string }[];
}

export interface SpecCheck {
  sectionsMissing: string[];
  sectionsEmpty: string[];
  sectionsFallback: string[];
  requirementCount: number;
  requirementIdsShortSequential: boolean;
  requirementIdsDuplicated: string[];
  requirementsWithoutAcceptance: string[];
  phaseTasksWithoutAcceptance: number;
  phaseCount: number;
  diagramCount: number;
  diagramsWithoutMermaid: string[];
  openQuestionCount: number;
  /** Requirement ids mentioned in task files that the document does not define. */
  unknownIdsInTasks: string[];
}

export function checkSpec(doc: SpecDocumentView, taskFiles: string[]): SpecCheck {
  const have = new Map(doc.sections.map((s) => [s.key, s]));
  const ids = doc.requirements.map((r) => r.id);
  const idRe = /^FR-\d{1,3}$/;
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  const known = new Set(ids);
  const mentioned = new Set<string>();
  for (const t of taskFiles) for (const m of t.matchAll(/\bFR-[A-Za-z0-9-]+/g)) mentioned.add(m[0]);
  return {
    sectionsMissing: SPEC_SECTION_KEYS.filter((k) => !have.has(k)),
    sectionsEmpty: doc.sections.filter((s) => s.markdown.trim().length < 80).map((s) => s.key),
    sectionsFallback: doc.sections.filter((s) => s.source === "fallback").map((s) => s.key),
    requirementCount: doc.requirements.length,
    requirementIdsShortSequential: ids.length > 0 && ids.every((id) => idRe.test(id)),
    requirementIdsDuplicated: [...dupes],
    requirementsWithoutAcceptance: doc.requirements.filter((r) => r.acceptance.length === 0).map((r) => r.id),
    phaseTasksWithoutAcceptance: doc.phases.flatMap((p) => p.tasks).filter((t) => t.acceptance.length === 0)
      .length,
    phaseCount: doc.phases.length,
    diagramCount: doc.diagrams.length,
    diagramsWithoutMermaid: doc.diagrams.filter((d) => d.mermaid.trim().length < 10).map((d) => d.key),
    openQuestionCount: doc.openQuestions.length,
    unknownIdsInTasks: [...mentioned].filter((id) => !known.has(id)),
  };
}

export const REQUIRED_BUNDLE_FILES = ["AGENTS.md", "PLAN.md", "spec.md", "spec.json"];

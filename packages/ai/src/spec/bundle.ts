import type { AgentBundle, BundleFormat, SpecDocument } from "@aidp/shared";
import { renderPhases, renderRequirements } from "./markdown.js";

const section = (doc: SpecDocument, key: string): string =>
  doc.sections.find((s) => s.key === key)?.markdown.trim() ?? "";

function agentsMd(doc: SpecDocument, format: BundleFormat): string {
  const agentName =
    format === "codex" ? "Codex" : format === "claude_code" ? "Claude Code" : "the coding agent";
  const parts: string[] = [
    `# ${doc.title}: context for ${agentName}`,
    "",
    "This bundle was generated from a requirements interview. `spec.md` is the full specification;",
    "`PLAN.md` lists the implementation phases; `tasks/phase-N.md` holds one phase's tasks with",
    "acceptance criteria. Build phase by phase, in order. Every acceptance criterion becomes a test.",
    "When the specification is silent, take the default recorded under Open questions; do not ask.",
    "",
  ];
  const push = (title: string, body: string): void => {
    if (body) parts.push(`## ${title}`, "", body, "");
  };
  push("Product and problem", section(doc, "overview"));
  push("Users and roles", section(doc, "users"));
  const ctx = Object.entries(doc.context);
  if (ctx.length) push("Context and constraints", ctx.map(([k, v]) => `- ${k}: ${v}`).join("\n"));
  push("Business rules", section(doc, "rules"));
  push("Technical requirements", section(doc, "technical"));
  push("Data", section(doc, "data"));
  push("Integrations", section(doc, "integrations"));
  push("Security and privacy", section(doc, "security"));
  push("Non-functional requirements", section(doc, "nfr"));
  push("Administrative surface", section(doc, "admin"));
  if (doc.openQuestions.length)
    push(
      "Open questions and the defaults taken",
      doc.openQuestions.map((q) => `- ${q.question} Default: ${q.defaultTaken}`).join("\n"),
    );
  parts.push(
    "## Working rules",
    "",
    "- Keep the ids from the specification (FR-n, phase keys) in commit messages and test names.",
    "- Do not add features outside the MVP scope; future-scope items are listed in `spec.md`.",
    "- Prefer the simplest implementation that meets the acceptance criteria.",
    "",
  );
  return `${parts.join("\n").trim()}\n`;
}

function planMd(doc: SpecDocument): string {
  const lines = [`# ${doc.title}: implementation plan`, ""];
  if (doc.phases.length === 0) {
    lines.push("No phases were generated. Build the MVP requirements in `spec.md` as one phase.", "");
  } else {
    lines.push("| Phase | Name | Depends on | Task file |", "| --- | --- | --- | --- |");
    doc.phases.forEach((p, i) => {
      lines.push(`| ${i + 1} | ${p.name} | ${p.dependencies.join(", ") || "-"} | tasks/phase-${i + 1}.md |`);
    });
    lines.push("", renderPhases(doc.phases), "");
  }
  const mvp = doc.requirements.filter((r) => r.scope === "mvp");
  if (mvp.length) lines.push("## MVP requirements", "", renderRequirements(mvp), "");
  return `${lines.join("\n").trim()}\n`;
}

function phaseMd(doc: SpecDocument, index: number, p: SpecDocument["phases"][number]): string {
  const lines = [`# Phase ${index + 1}: ${p.name}`, ""];
  if (p.goals.length) lines.push("## Goals", "", ...p.goals.map((g) => `- ${g}`), "");
  if (p.dependencies.length) lines.push(`Depends on: ${p.dependencies.join(", ")}`, "");
  lines.push("## Tasks", "");
  p.tasks.forEach((t, i) => {
    lines.push(`### ${index + 1}.${i + 1} ${t.title}`, "");
    if (t.acceptance.length) lines.push("Acceptance:", ...t.acceptance.map((a) => `- [ ] ${a}`), "");
  });
  if (p.acceptance.length)
    lines.push("## Phase acceptance", "", ...p.acceptance.map((a) => `- [ ] ${a}`), "");
  lines.push("## Related requirements", "");
  const ids = new Set(
    doc.requirements
      .filter((r) => r.scope === "mvp")
      .filter((r) => p.tasks.some((t) => t.title.includes(r.id)) || p.goals.some((g) => g.includes(r.id)))
      .map((r) => r.id),
  );
  const related = doc.requirements.filter((r) => ids.has(r.id));
  lines.push(related.length ? renderRequirements(related) : "See `spec.md`.", "");
  return `${lines.join("\n").trim()}\n`;
}

/** The agent bundle (FR-25): AGENTS.md, PLAN.md, one task file per phase, plus the spec itself. */
export function renderBundle(doc: SpecDocument, format: BundleFormat, specMarkdown: string): AgentBundle {
  const files: AgentBundle["files"] = [
    { path: "AGENTS.md", content: agentsMd(doc, format) },
    { path: "PLAN.md", content: planMd(doc) },
    ...doc.phases.map((p, i) => ({ path: `tasks/phase-${i + 1}.md`, content: phaseMd(doc, i, p) })),
    { path: "spec.md", content: specMarkdown },
    { path: "spec.json", content: `${JSON.stringify(doc, null, 2)}\n` },
  ];
  if (format === "claude_code") {
    files.unshift({
      path: "CLAUDE.md",
      content: `# ${doc.title}\n\n@AGENTS.md\n\nStart with PLAN.md, then the task file of the current phase.\n`,
    });
  } else if (format === "generic") {
    files.unshift({
      path: "README.md",
      content: `# ${doc.title}\n\nSpecification bundle. Read AGENTS.md for context, PLAN.md for the phases, tasks/ for the work items, spec.md for the full specification.\n`,
    });
  }
  return { format, files };
}

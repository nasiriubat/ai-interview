import type { SpecDocument, SpecPhase, SpecRequirement } from "@aidp/shared";

const fence = (mermaid: string): string => `\`\`\`mermaid\n${mermaid.trim()}\n\`\`\``;

export function renderRequirements(reqs: SpecRequirement[]): string {
  if (reqs.length === 0) return "";
  const block = (scope: "mvp" | "future"): string => {
    const list = reqs.filter((r) => r.scope === scope);
    if (list.length === 0) return "";
    const lines = [`### ${scope === "mvp" ? "MVP" : "Future"}`, ""];
    for (const r of list) {
      lines.push(`- **${r.id}** ${r.title}${r.tracedTo ? ` _(traces to ${r.tracedTo})_` : ""}`);
      for (const a of r.acceptance) lines.push(`  - Acceptance: ${a}`);
      if (r.reason) lines.push(`  - Reason: ${r.reason}`);
    }
    return lines.join("\n");
  };
  return [block("mvp"), block("future")].filter(Boolean).join("\n\n");
}

export function renderPhases(phases: SpecPhase[]): string {
  return phases
    .map((p, i) => {
      const lines = [`### Phase ${i + 1}: ${p.name}`, ""];
      if (p.goals.length) lines.push("Goals:", ...p.goals.map((g) => `- ${g}`), "");
      if (p.tasks.length) {
        lines.push("Tasks:");
        for (const t of p.tasks) {
          lines.push(`- ${t.title}`);
          for (const a of t.acceptance) lines.push(`  - Acceptance: ${a}`);
        }
        lines.push("");
      }
      if (p.dependencies.length) lines.push(`Depends on: ${p.dependencies.join(", ")}`, "");
      if (p.acceptance.length) lines.push("Phase acceptance:", ...p.acceptance.map((a) => `- ${a}`));
      return lines.join("\n").trim();
    })
    .join("\n\n");
}

/** spec.md (FR-24): the human-readable document, structured parts rendered deterministically. */
export function renderSpecMarkdown(doc: SpecDocument): string {
  const out: string[] = [`# ${doc.title}`, ""];
  const meta = [
    `Language: ${doc.language}`,
    doc.path ? `Path: ${doc.path}` : "",
    `Generated: ${doc.generatedAt}`,
  ].filter(Boolean);
  out.push(meta.join(" · "), "");
  const ctx = Object.entries(doc.context);
  if (ctx.length) {
    out.push("## Context", "", "| Question | Answer |", "| --- | --- |");
    for (const [k, v] of ctx) out.push(`| ${k} | ${v.replace(/\|/g, "\\|")} |`);
    out.push("");
  }
  const entity = doc.diagrams.find((d) => d.type === "entity");
  for (const s of doc.sections) {
    out.push(`## ${s.title}`, "");
    if (s.markdown.trim()) out.push(s.markdown.trim(), "");
    if (s.source !== "edited") {
      if (s.key === "functional") {
        const r = renderRequirements(doc.requirements);
        if (r) out.push(r, "");
      } else if (s.key === "phases") {
        const p = renderPhases(doc.phases);
        if (p) out.push(p, "");
      } else if (s.key === "open_questions" && doc.openQuestions.length) {
        for (const q of doc.openQuestions) out.push(`- ${q.question} _Default taken: ${q.defaultTaken}_`);
        out.push("");
      } else if (s.key === "mvp") {
        if (doc.mvp.in.length) out.push("In version one:", ...doc.mvp.in.map((x) => `- ${x}`), "");
        if (doc.mvp.movedOut.length)
          out.push("Moved to future scope:", ...doc.mvp.movedOut.map((x) => `- ${x.id}: ${x.reason}`), "");
        if (doc.mvp.next.length) out.push("Next:", ...doc.mvp.next.map((x) => `- ${x}`), "");
      } else if (s.key === "data" && entity) {
        out.push(`### ${entity.title}`, "", fence(entity.mermaid), "");
      } else if (s.key === "diagrams") {
        for (const d of doc.diagrams) out.push(`### ${d.title}`, "", fence(d.mermaid), "");
      }
    }
  }
  return `${out.join("\n").trim()}\n`;
}

import { describe, expect, it } from "vitest";
import { extractMermaidBlocks } from "@/lib/report/mermaid";
import { parseReportSections, splitReportSections, visibleMarkdown } from "@/lib/report/sections";

describe("extractMermaidBlocks", () => {
  it("returns a single markdown segment when there are no diagrams", () => {
    expect(extractMermaidBlocks("# Title\n\nText")).toEqual([{ kind: "markdown", text: "# Title\n\nText" }]);
  });

  it("splits mermaid fences out and keeps surrounding markdown", () => {
    const md = "Intro\n\n```mermaid\ngraph LR\n  A --> B\n```\n\nOutro";
    expect(extractMermaidBlocks(md)).toEqual([
      { kind: "markdown", text: "Intro\n" },
      { kind: "mermaid", code: "graph LR\n  A --> B" },
      { kind: "markdown", text: "\nOutro" },
    ]);
  });

  it("leaves other code fences alone, including nested mermaid fences", () => {
    const md = "```ts\nconst a = 1;\n```\n\n````markdown\n```mermaid\ngraph TD\n```\n````\n";
    const out = extractMermaidBlocks(md);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "markdown" });
    expect((out[0] as { text: string }).text).toContain("```mermaid\ngraph TD\n```");
  });

  it("supports tilde fences, indentation, CRLF and an unterminated block", () => {
    expect(extractMermaidBlocks("~~~mermaid\r\nflowchart TD\r\n~~~\r\n")).toEqual([
      { kind: "mermaid", code: "flowchart TD" },
    ]);
    expect(extractMermaidBlocks("  ```mermaid\n  pie\n  ```")).toEqual([{ kind: "mermaid", code: "pie" }]);
    expect(extractMermaidBlocks("Text\n```mermaid\ngraph LR\nA-->B")).toEqual([
      { kind: "markdown", text: "Text" },
      { kind: "mermaid", code: "graph LR\nA-->B" },
    ]);
  });

  it("does not close a fence with a shorter one or one with an info string", () => {
    const md = "````mermaid\ngraph LR\n```\nstill diagram\n````\n";
    expect(extractMermaidBlocks(md)).toEqual([{ kind: "mermaid", code: "graph LR\n```\nstill diagram" }]);
  });
});

describe("splitReportSections", () => {
  const sections = ["executive_summary", "work_map", "next_steps"];

  it("assigns level-2 headings to sections in order and keeps the preamble", () => {
    const md =
      "# Report\n\nIntro\n\n## Summary\nA\n\n## Map\n```mermaid\n## not a heading\n```\n\n## Next\nC\n\n## Extra\nD";
    const chunks = splitReportSections(md, sections);
    expect(chunks.map((c) => c.key)).toEqual([null, "executive_summary", "work_map", "next_steps", null]);
    expect(chunks[2]!.markdown).toContain("## not a heading");
    const visible = visibleMarkdown(chunks, new Set(["executive_summary", "next_steps"]));
    expect(visible).toContain("# Report");
    expect(visible).toContain("## Summary");
    expect(visible).not.toContain("## Map");
    expect(visible).toContain("## Next");
    expect(visible).toContain("## Extra");
  });

  it("prefers explicit section markers when present", () => {
    const md =
      "Intro\n<!-- section: work_map -->\n## Anything\nmap\n<!-- section:not_ai -->\n## Other\nno\n<!-- section: bogus -->\nrest";
    const chunks = splitReportSections(md, sections);
    expect(chunks.map((c) => c.key)).toEqual([null, "work_map", "not_ai", null]);
    expect(chunks.some((c) => c.markdown.includes("<!--"))).toBe(false);
    expect(visibleMarkdown(chunks, new Set(["not_ai"]))).toBe("Intro\n## Other\nno\nrest");
  });

  it("parses the settings value tolerantly", () => {
    expect(parseReportSections(["work_map", "junk", "not_ai"])).toEqual(["work_map", "not_ai"]);
    // Every section, department_comparison (FR-17) included.
    expect(parseReportSections(undefined)).toHaveLength(8);
  });
});

describe("the report cover does not shift the section mapping", () => {
  const cover =
    "# Discovery report: Ward\n\nGenerated 2026-10-14.\n\n**Method.** 6 of 8 invited people completed.\n\n" +
    "**What this report does not do.** It does not name anyone.\n\n**Reproducibility.** template t v1.\n\n";

  it("keeps the cover as unkeyed preface and maps the n-th heading to the n-th section", () => {
    const md = `${cover}## Executive summary\n\nE\n\n## Participation and method\n\nP\n\n## Recommended next steps\n\nN\n`;
    const chunks = splitReportSections(md, ["executive_summary", "participation", "next_steps"]);
    expect(chunks.map((c) => c.key)).toEqual([null, "executive_summary", "participation", "next_steps"]);
    expect(chunks[0]?.markdown).toContain("**Reproducibility.**");
    const shown = visibleMarkdown(chunks, new Set(["next_steps"]));
    expect(shown).toContain("**Method.**");
    expect(shown).toContain("## Recommended next steps");
    expect(shown).not.toContain("## Executive summary");
  });
});

"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram";
import { extractMermaidBlocks } from "@/lib/report/mermaid";

/** GFM Markdown with Mermaid fences rendered as diagrams. No raw HTML is rendered. */
export function ReportMarkdown({ markdown }: { markdown: string }): React.JSX.Element {
  const segments = React.useMemo(() => extractMermaidBlocks(markdown), [markdown]);
  return (
    <div className="report-prose">
      {segments.map((seg, i) =>
        seg.kind === "mermaid" ? (
          <MermaidDiagram key={i} code={seg.code} />
        ) : (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
            {seg.text}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
}

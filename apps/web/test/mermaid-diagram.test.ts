import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DIAGRAM_SCRATCH_CLASS, MAX_DIAGRAM_UNITS, viewBoxSize } from "@/components/report/MermaidDiagram";

/*
 * D-320. In the demo run every flowchart, state and entity diagram came out 16,000 units wide for
 * anyone whose system asked for reduced motion: the global reduced-motion rule forced a
 * near-zero `transition-duration` on every element, including the labels Mermaid measures while it
 * lays a drawing out. The browser spec (`e2e/diagrams.spec.ts`, "reduced-motion" project) measures
 * the real drawing; these are the parts that can fail without a browser.
 */

const css = readFileSync(path.join(import.meta.dirname, "../src/app/globals.css"), "utf8");

describe("viewBoxSize", () => {
  it("reads width and height from the root element", () => {
    expect(viewBoxSize('<svg id="m" width="100%" viewBox="0 0 855.39 350.23" role="x"></svg>')).toEqual({
      width: 855.39,
      height: 350.23,
    });
    expect(viewBoxSize('<svg viewBox="-50 -10 1008 493">')).toEqual({ width: 1008, height: 493 });
  });

  it("says nothing when there is no usable viewBox", () => {
    expect(viewBoxSize("<svg></svg>")).toBeNull();
    expect(viewBoxSize('<svg viewBox="0 0 NaN 5">')).toBeNull();
  });

  it("treats the sizes the demo produced as out of bounds", () => {
    const box = viewBoxSize('<svg viewBox="0 0 16528.83 16439.47">');
    expect(box?.width).toBeGreaterThan(MAX_DIAGRAM_UNITS);
  });
});

describe("the reduced-motion rule", () => {
  const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  it("still neutralises motion on the interface", () => {
    expect(block).toContain("transition-duration: 0.01ms !important");
    expect(block).toContain("animation-duration: 0.01ms !important");
  });

  it("leaves a diagram's scratch element and its drawing alone", () => {
    expect(block).toContain(
      `:not(.${DIAGRAM_SCRATCH_CLASS}, .${DIAGRAM_SCRATCH_CLASS} *, .report-diagram *)`,
    );
  });
});

describe("the diagram's size in a narrow column", () => {
  it("keeps a floor under the scale and lets the figure scroll", () => {
    expect(css).toMatch(/\.report-diagram svg \{[^}]*min-width: min\(var\(--diagram-natural/);
  });
});

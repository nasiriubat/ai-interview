import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The design tokens that WCAG 1.4.11 (non-text contrast), 2.4.7/2.4.11 (focus) and 2.3.3 (motion)
 * depend on, read from the stylesheet itself so a colour edit cannot silently drop below the bar.
 */
const srcDir = path.resolve(import.meta.dirname, "../src");
const css = readFileSync(path.join(srcDir, "app/globals.css"), "utf8");

function rootBlock(): string {
  const start = css.indexOf(":root {");
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(rootBlock());
  if (!match?.[1]) throw new Error(`token --${name} is not a plain hex value in :root`);
  return match[1];
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("control boundary and focus contrast", () => {
  it("the control boundary reaches 3:1 on cards and on the canvas", () => {
    expect(contrast(token("input"), token("card"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token("input"), token("background"))).toBeGreaterThanOrEqual(3);
  });

  it("hover darkens the boundary instead of lightening it", () => {
    expect(contrast(token("input-hover"), token("card"))).toBeGreaterThan(
      contrast(token("input"), token("card")),
    );
  });

  it("the switch thumb is distinguishable from its off track", () => {
    expect(contrast("#ffffff", token("input"))).toBeGreaterThanOrEqual(3);
  });

  it("the focus colour reaches 3:1 on every surface it is drawn over", () => {
    for (const surface of ["card", "background", "muted", "accent"]) {
      expect(contrast(token("ring"), token(surface))).toBeGreaterThanOrEqual(3);
    }
  });

  it("form controls draw their boundary from the --input token, buttons keep a decorative edge", () => {
    expect(css).toMatch(/--shadow-control:\s*0 0 0 1px var\(--input\)/);
    expect(css).toMatch(/--shadow-button:/);
  });

  it("focus is a solid outline, not a half-transparent one", () => {
    expect(css).toMatch(/\*\s*\{\s*@apply border-border outline-ring;\s*\}/);
    expect(css).toMatch(/:focus-visible\s*\{\s*@apply outline-2 outline-offset-2 outline-ring;/);
  });
});

describe("reduced motion", () => {
  it("has one global rule that shortens animation and transition durations", () => {
    const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toContain("animation-duration: 0.01ms !important");
    expect(block).toContain("animation-iteration-count: 1 !important");
    expect(block).toContain("transition-duration: 0.01ms !important");
    expect(block).toContain("scroll-behavior: auto !important");
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("components use tokens, not raw colours or per-component focus rings", () => {
  const files = walk(path.join(srcDir, "components")).filter((f) => /\.tsx?$/.test(f));

  it("has no raw hex colours outside the stylesheet", () => {
    const offenders = files.flatMap((f) => {
      const hits = readFileSync(f, "utf8").match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/g) ?? [];
      return hits.filter((h) => !/^#\d+$/.test(h)).map((h) => `${path.relative(srcDir, f)} ${h}`);
    });
    // MermaidDiagram themes the diagram engine, which cannot read CSS variables.
    expect(offenders.filter((o) => !o.includes("report/"))).toEqual([]);
  });

  it("removes focus outlines and half-transparent rings only where the global rule is replaced", () => {
    const offenders = files.flatMap((f) => {
      const text = readFileSync(f, "utf8");
      const found =
        text.match(/\boutline-none\b|focus-visible:ring-ring\/\d+|focus-visible:ring-\[3px\]/g) ?? [];
      return found.map((h) => `${path.relative(srcDir, f)} ${h}`);
    });
    expect(offenders).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  blockOf,
  check,
  contrast,
  PAIRS,
  readStylesheet,
  report,
  resolve,
  systemDarkBlock,
  themeTokens,
} from "../scripts/contrast";

/*
 * Every colour pair the interface uses, in both themes (WCAG 1.4.3, 1.4.11, 2.4.11), computed from
 * the stylesheet. The script is also runnable by hand: `pnpm --filter @aidp/web contrast`.
 */

const css = readStylesheet();

describe("contrast of every token pair", () => {
  const findings = check(css);

  it("covers both themes and a real number of pairs", () => {
    expect(PAIRS.length).toBeGreaterThan(30);
    expect(findings).toHaveLength(PAIRS.length * 2);
    // A pair that resolves to nothing would pass silently as "no ratio": it must be a failure.
    expect(findings.filter((f) => f.ratio === null)).toEqual([]);
  });

  it.each(["light", "dark"] as const)("passes 4.5:1 for text and 3:1 for edges in the %s theme", (theme) => {
    const failed = findings.filter((f) => f.theme === theme && !f.ok);
    expect(report(failed)).toBe("");
  });

  it("computes the ratio the way WCAG defines it", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // The white-on-indigo of the primary button, to a reference value.
    expect(contrast("#5f56fa", "#ffffff")).toBeGreaterThan(4.9);
  });

  it("resolves var() references and refuses what is not a plain colour", () => {
    expect(resolve({ a: "#112233", b: "var(--a)" }, "var(--b)")).toBe("#112233");
    expect(resolve({}, "var(--missing)")).toBeNull();
    expect(resolve({ a: "rgb(0 0 0 / 0.5)" }, "var(--a)")).toBeNull();
  });
});

describe("the dark theme", () => {
  const light = themeTokens(css, "light");
  const dark = themeTokens(css, "dark");
  const darkOwn = blockOf(css, ':root[data-theme="dark"]');

  it("says the same thing when it follows the system as when it is chosen", () => {
    const system = systemDarkBlock(css);
    expect(Object.keys(system).length).toBeGreaterThan(30);
    expect(system).toEqual(darkOwn);
  });

  it("is applied to the page by an attribute, and the system's setting yields to a chosen light", () => {
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {');
    expect(darkOwn["color-scheme"]).toBe("dark");
  });

  it("gives a value to every colour a component can read, or says it is the same in both themes", () => {
    // Fixed on purpose: the brand mark and band are white-on-indigo in both themes, and the
    // radius is not a colour. A new colour token has to be added to the dark block or to this list.
    const SAME = new Set([
      "radius",
      "brand-1",
      "brand-2",
      "brand-text",
      "brand-gradient",
      "brand-band",
      "brand-panel",
    ]);
    const missing = Object.keys(light).filter(
      (k) => !(k in darkOwn) && !SAME.has(k) && !k.startsWith("switch-track"),
    );
    expect(missing).toEqual([]);
  });

  it("names no token the light theme does not have", () => {
    expect(Object.keys(darkOwn).filter((k) => !(k in light) && k !== "color-scheme")).toEqual([]);
  });

  it("is dark: the canvas is darker than a card, which is darker than the text on it", () => {
    const lum = (hex: string): number => contrast(hex, "#000000");
    const bg = resolve(dark, "var(--background)");
    const card = resolve(dark, "var(--card)");
    const fg = resolve(dark, "var(--foreground)");
    expect(bg && card && fg).toBeTruthy();
    expect(lum(bg!)).toBeLessThan(lum(card!));
    expect(lum(card!)).toBeLessThan(lum(fg!));
  });

  it("keeps the brand mark and the destructive fill readable in both themes", () => {
    for (const tokens of [light, dark]) {
      const mark = contrast(resolve(tokens, "var(--brand-text)")!, resolve(tokens, "var(--brand-1)")!);
      expect(mark).toBeGreaterThanOrEqual(4.5);
      const fill = contrast(
        resolve(tokens, "var(--destructive-foreground)")!,
        resolve(tokens, "var(--destructive)")!,
      );
      expect(fill).toBeGreaterThanOrEqual(4.5);
    }
  });
});

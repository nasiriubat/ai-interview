/**
 * Contrast check of every colour pair the interface uses, in the light and the dark theme (D-110,
 * D-238). It reads the tokens out of `src/app/globals.css`, so a colour edit cannot silently drop
 * below the bar, and it is run by the web tests (`test/contrast.test.ts`) as well as by hand:
 *
 *     pnpm --filter @aidp/web contrast
 *
 * Thresholds (WCAG 2.2): 4.5:1 for text, 3:1 for the boundary of a control, a focus ring and the
 * parts of a graphic that carry meaning (1.4.3, 1.4.11, 2.4.11). Every pair is named, with the
 * place it is used, so a failure says what would be unreadable.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Theme = "light" | "dark";

export interface Pair {
  /** `foreground` token, or a literal `#rrggbb`. */
  fg: string;
  /** `background` token, or a literal `#rrggbb`. */
  bg: string;
  /** 4.5 for text, 3 for a boundary or a ring. */
  min: 3 | 4.5;
  /** Where the pair is used, for the failure message. */
  use: string;
}

const text = (fg: string, bg: string, use: string): Pair => ({ fg, bg, min: 4.5, use });
const edge = (fg: string, bg: string, use: string): Pair => ({ fg, bg, min: 3, use });

/** Every foreground and background that meet in the interface. */
export const PAIRS: readonly Pair[] = [
  text("foreground", "background", "page text"),
  text("foreground", "card", "headings on a card"),
  text("card-foreground", "card", "card text"),
  text("popover-foreground", "popover", "menus, popovers, dialogs"),
  text("body", "background", "body text on the canvas"),
  text("body", "card", "body text on a card"),
  text("muted-foreground", "background", "secondary text on the canvas"),
  text("muted-foreground", "card", "secondary text on a card"),
  text("muted-foreground", "muted", "secondary text in an inset"),
  text("secondary-foreground", "secondary", "secondary buttons"),
  text("primary", "card", "links and the text of the current item"),
  text("primary", "background", "links on the canvas"),
  text("primary", "muted", "links in an inset"),
  text("primary-foreground", "primary", "primary buttons"),
  text("primary-foreground", "primary-hover", "primary buttons while hovered"),
  text("accent-foreground", "accent", "selected tile and menu item"),
  text("destructive", "card", "error text on a card"),
  text("destructive", "background", "error text on the canvas"),
  text("destructive-foreground", "destructive", "destructive buttons"),
  text("destructive-soft-foreground", "destructive-soft", "error alerts and badges"),
  text("success-soft-foreground", "success-soft", "success alerts and badges"),
  text("success-soft-foreground", "card", "success text on a card"),
  text("warning-soft-foreground", "warning-soft", "warning alerts and badges"),
  text("info-soft-foreground", "info-soft", "information alerts and badges"),
  text("sidebar-foreground", "sidebar", "navigation"),
  text("sidebar-accent-foreground", "sidebar-accent", "the current navigation item"),
  text("brand-text", "brand-1", "the mark in the header"),
  edge("input", "card", "the boundary of a control on a card"),
  edge("input", "background", "the boundary of a control on the canvas"),
  edge("input-hover", "card", "the boundary of a control under the pointer"),
  edge("ring", "card", "the focus ring on a card"),
  edge("ring", "background", "the focus ring on the canvas"),
  edge("ring", "muted", "the focus ring in an inset"),
  edge("ring", "accent", "the focus ring on a selected tile"),
  edge("primary", "card", "a selected tile's ring and the fill of a progress bar"),
  edge("success", "card", "the check mark of a passed check"),
  edge("warning", "card", "the amber of a spend bar"),
  edge("destructive", "muted", "the red of a spend bar on its track"),
];

type Tokens = Record<string, string>;

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The declarations of the block that starts at `selector {`, or `{}` when there is none. */
export function blockOf(css: string, selector: string): Tokens {
  const clean = stripComments(css);
  const at = clean.indexOf(`${selector} {`);
  if (at < 0) return {};
  const open = clean.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    if (clean[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = clean.slice(open + 1, end);
  const out: Tokens = {};
  for (const m of body.matchAll(/(?:--([a-z0-9-]+)|(color-scheme))\s*:\s*([^;]+);/g)) {
    const name = m[1] ?? m[2];
    const value = m[3];
    if (name && value) out[name] = value.trim().replace(/\s+/g, " ");
  }
  return out;
}

/** Every token in force for a theme: the light block, with the dark block laid over it. */
export function themeTokens(css: string, theme: Theme): Tokens {
  const light = blockOf(css, ":root");
  if (theme === "light") return light;
  return { ...light, ...blockOf(css, ':root[data-theme="dark"]') };
}

/** The dark block of the `prefers-color-scheme` rule, which must say the same as the attribute one. */
export function systemDarkBlock(css: string): Tokens {
  const clean = stripComments(css);
  const at = clean.indexOf("@media (prefers-color-scheme: dark)");
  if (at < 0) return {};
  const inner = clean.slice(at);
  return blockOf(inner, ':root:not([data-theme="light"])');
}

const HEX = /^#([0-9a-f]{6})$/i;

/** Follows `var(--x)` references; null when the value is not a plain hex colour in the end. */
export function resolve(tokens: Tokens, value: string, depth = 0): string | null {
  if (depth > 8) return null;
  const v = value.trim();
  if (HEX.test(v)) return v.toLowerCase();
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(v);
  if (ref?.[1]) {
    const next = tokens[ref[1]];
    return next === undefined ? null : resolve(tokens, next, depth + 1);
  }
  return null;
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface Finding {
  theme: Theme;
  pair: Pair;
  fg: string | null;
  bg: string | null;
  ratio: number | null;
  ok: boolean;
}

export function check(css: string): Finding[] {
  const out: Finding[] = [];
  for (const theme of ["light", "dark"] as const) {
    const tokens = themeTokens(css, theme);
    const colour = (name: string): string | null =>
      HEX.test(name) ? name.toLowerCase() : resolve(tokens, `var(--${name})`);
    for (const pair of PAIRS) {
      const fg = colour(pair.fg);
      const bg = colour(pair.bg);
      const ratio = fg && bg ? contrast(fg, bg) : null;
      out.push({ theme, pair, fg, bg, ratio, ok: ratio !== null && ratio >= pair.min });
    }
  }
  return out;
}

export function readStylesheet(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(path.join(here, "../src/app/globals.css"), "utf8");
}

export function report(findings: readonly Finding[]): string {
  const lines = findings.map((f) => {
    const r = f.ratio === null ? "unresolved" : f.ratio.toFixed(2);
    return `${f.ok ? "ok  " : "FAIL"} ${f.theme.padEnd(5)} ${r.padStart(10)} (need ${String(f.pair.min)})  ${f.pair.fg} on ${f.pair.bg}: ${f.pair.use}`;
  });
  return lines.join("\n");
}

// Run by hand: exits 1 on any failure.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const findings = check(readStylesheet());
  process.stdout.write(`${report(findings)}\n`);
  const failed = findings.filter((f) => !f.ok);
  process.stdout.write(
    `\n${String(findings.length - failed.length)} of ${String(findings.length)} pairs pass.\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

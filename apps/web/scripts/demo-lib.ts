/* eslint-disable -- one-off marketing demo tooling, not product code (marketing/demo-2026-10/README.md) */
/**
 * Shared helpers for the marketing demo screenshots (marketing/demo-2026-10). Not part of the
 * product: it drives a locally running stack (API on 4110, web on 3200) and writes PNGs.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { staffToken } from "../../../scripts/live-run/src/api.js";

export const WEB = "http://localhost:3200";
export const API = "http://127.0.0.1:4110/api/v1";
export const SHOTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../marketing/demo-2026-10/screenshots",
);
export const STATE = "/private/tmp/claude-504/d";

export const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(STATE, file), "utf8")) as T;

export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 390, height: 844 };

export async function launch(): Promise<Browser> {
  return chromium.launch();
}

export interface CtxOptions {
  mobile?: boolean;
  dark?: boolean;
  locale?: "en" | "fi";
  staff?: "admin" | "operator" | false;
}

/** A browser context at the demo's sizes, optionally signed in as staff with a minted session. */
export async function context(browser: Browser, o: CtxOptions = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: o.mobile ? MOBILE : DESKTOP,
    deviceScaleFactor: o.mobile ? 3 : 2,
    isMobile: o.mobile ?? false,
    hasTouch: o.mobile ?? false,
    colorScheme: o.dark ? "dark" : "light",
    locale: o.locale === "fi" ? "fi-FI" : "en-GB",
    reducedMotion: "reduce",
  });
  if (o.locale) await ctx.addCookies([{ name: "lang", value: o.locale, url: WEB }]);
  if (o.staff) {
    const { authSecret } = readJson<{ authSecret: string }>("demo-state.json");
    const email = o.staff === "operator" ? "live-operator@example.test" : "live-admin@example.test";
    await ctx.addCookies([
      { name: "authjs.session-token", value: await staffToken(email, authSecret), url: WEB },
    ]);
  }
  return ctx;
}

/** Waits for the page to settle, then writes `<case>/<name>.png`. */
export async function shot(
  page: Page,
  folder: string,
  name: string,
  opts: { full?: boolean } = {},
): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(700);
  const dir = join(SHOTS, folder);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: opts.full ?? false });
  console.log(`shot ${folder}/${name}`);
}

/** Staff API call with a minted token, for looking things up (ids), never for secrets. */
export async function staffApi<T>(path: string, who: "admin" | "operator" = "admin"): Promise<T> {
  const { authSecret } = readJson<{ authSecret: string }>("demo-state.json");
  const email = who === "operator" ? "live-operator@example.test" : "live-admin@example.test";
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${await staffToken(email, authSecret)}` },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

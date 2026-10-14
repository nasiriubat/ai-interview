/*
 * Screenshots of the admin pages at the widths and themes a design review looks at (D-348).
 * Not part of the test run: it writes images for a person to look at.
 *
 *   BASE=http://localhost:3190 OUT=/tmp/shots PAGES=/admin,/admin/users pnpm exec tsx scripts/screenshots.ts
 *
 * Optional: WIDTHS=390,768,1280,1920  THEMES=light,dark  LOCALES=en,fi  FULL=1 (full-page shots).
 * It signs in with an Auth.js cookie minted from E2E_AUTH_SECRET, the way the e2e suite does, so the
 * target must be a server pointed at the fake API (`e2e/fake-api.ts`).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { encode } from "next-auth/jwt";

const BASE = process.env.BASE ?? "http://localhost:3190";
const OUT = process.env.OUT ?? "/tmp/shots";
const SECRET = process.env.AUTH_SECRET ?? "e2e-auth-secret-e2e-auth-secret-0123456789";
const PAGES = (process.env.PAGES ?? "/admin").split(",");
const WIDTHS = (process.env.WIDTHS ?? "390,768,1280,1920").split(",").map(Number);
const THEMES = (process.env.THEMES ?? "light,dark").split(",");
const LOCALES = (process.env.LOCALES ?? "en").split(",");
const FULL = process.env.FULL === "1";
const COLLAPSED = process.env.COLLAPSED === "1";

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const token = await encode({
  // ROLE=platform_operator shows the operator's pages and the platform scope (the fake API reads the claim).
  token: { email: "ada@acme.test", sub: "u1", ...(process.env.ROLE ? { role: process.env.ROLE } : {}) },
  secret: SECRET,
  salt: "authjs.session-token",
});
const host = new URL(BASE).hostname;

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width, height: width < 600 ? 844 : 900 },
        locale: locale === "fi" ? "fi-FI" : "en-GB",
        colorScheme: theme === "dark" ? "dark" : "light",
      });
      await context.addCookies([
        { name: "authjs.session-token", value: token, domain: host, path: "/" },
        { name: "lang", value: locale, domain: host, path: "/" },
        ...(COLLAPSED ? [{ name: "aidp-sidebar", value: "collapsed", domain: host, path: "/" }] : []),
      ]);
      const page = await context.newPage();
      for (const p of PAGES) {
        await page.goto(`${BASE}${p}`, { waitUntil: "networkidle" });
        const name = `${p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"}-${locale}-${theme}-${String(width)}${COLLAPSED ? "-collapsed" : ""}.png`;
        await page.screenshot({ path: path.join(OUT, name), fullPage: FULL });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        if (overflow) console.warn(`HORIZONTAL SCROLL: ${p} at ${String(width)}`);
      }
      await context.close();
    }
  }
}
await browser.close();
console.warn(`wrote screenshots to ${OUT}`);

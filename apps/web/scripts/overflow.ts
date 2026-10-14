/*
 * Names the elements that make the page scroll sideways, signed in as the e2e admin:
 *   BASE=http://localhost:3190 PATH_=/admin/templates,/admin/prompts WIDTH=390 pnpm exec tsx scripts/overflow.ts
 * An element inside a scroller of its own (a table in `overflow-x-auto`) is not the page's problem
 * and is skipped; what is listed reaches past the viewport with nothing clipping it.
 */
import { chromium } from "@playwright/test";
import { encode } from "next-auth/jwt";

const BASE = process.env.BASE ?? "http://localhost:3190";
const SECRET = process.env.AUTH_SECRET ?? "e2e-auth-secret-e2e-auth-secret-0123456789";
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: Number(process.env.WIDTH ?? 390), height: 800 },
});
await context.addCookies([
  {
    name: "authjs.session-token",
    value: await encode({
      token: { email: "ada@acme.test", sub: "u1" },
      secret: SECRET,
      salt: "authjs.session-token",
    }),
    domain: new URL(BASE).hostname,
    path: "/",
  },
  { name: "lang", value: process.env.LANG_ ?? "en", domain: new URL(BASE).hostname, path: "/" },
]);
const page = await context.newPage();
for (const path of (process.env.PATH_ ?? "/dev/ui").split(",")) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  const result = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad = [...document.querySelectorAll("body *")].filter((e) => {
      if (e.getBoundingClientRect().right <= w + 1) return false;
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (
          (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") &&
          getComputedStyle(e).position !== "absolute" &&
          getComputedStyle(e).position !== "fixed"
        )
          return false;
      }
      return true;
    });
    return {
      scroll: `${String(document.documentElement.scrollWidth)} of ${String(w)}`,
      names: bad.slice(0, 8).map((e) => {
        const r = e.getBoundingClientRect();
        return `${e.tagName.toLowerCase()}#${e.id}.${e.className.slice(0, 90)} right=${String(Math.round(r.right))} w=${String(Math.round(r.width))}`;
      }),
    };
  });
  console.warn(`${path} scrollWidth ${result.scroll}\n${result.names.join("\n")}`);
}
await browser.close();

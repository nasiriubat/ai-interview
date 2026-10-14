/*
 * Names the elements that make the page scroll sideways (D-348): the ones that stick out past the
 * viewport and are not inside a container that scrolls or clips them.
 *
 *   BASE=http://localhost:3410 PATH_=/admin/users WIDTH=390 pnpm exec tsx scripts/overflow.ts
 *
 * It signs in with the e2e secret, so the target must run against the fake API.
 */
import { chromium } from "@playwright/test";
import { encode } from "next-auth/jwt";

const BASE = process.env.BASE ?? "http://localhost:3190";
const browser = await chromium.launch();
const token = await encode({
  token: { email: "ada@acme.test", sub: "u1" },
  secret: process.env.AUTH_SECRET ?? "e2e-auth-secret-e2e-auth-secret-0123456789",
  salt: "authjs.session-token",
});
const context = await browser.newContext({
  viewport: { width: Number(process.env.WIDTH ?? 390), height: 800 },
});
await context.addCookies([
  { name: "authjs.session-token", value: token, domain: new URL(BASE).hostname, path: "/" },
]);
const page = await context.newPage();
await page.goto(`${BASE}${process.env.PATH_ ?? "/dev/ui"}`, { waitUntil: "networkidle" });
const out = await page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [...document.querySelectorAll("body *")].filter((e) => {
    if (e.getBoundingClientRect().right <= w + 1) return false;
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      // An absolutely positioned child escapes a scroller that is not its containing block.
      if (getComputedStyle(p).overflowX !== "visible" && getComputedStyle(e).position !== "absolute")
        return false;
    }
    return true;
  });
  return bad
    .filter((e) => !bad.includes(e.parentElement as Element))
    .map(
      (e) =>
        `${e.tagName.toLowerCase()}#${e.id}.${String(e.className).slice(0, 90)} right=${String(Math.round(e.getBoundingClientRect().right))} parent=${e.parentElement?.tagName.toLowerCase() ?? ""}.${String(e.parentElement?.className ?? "").slice(0, 60)}`,
    );
});
console.warn(
  `viewport ${String(await page.evaluate(() => document.documentElement.clientWidth))} scroll ${String(await page.evaluate(() => document.documentElement.scrollWidth))}\n${out.join("\n")}`,
);
await browser.close();

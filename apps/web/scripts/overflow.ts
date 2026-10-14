/* Names the elements that stick out past the viewport: `BASE=... PATH_=/dev/ui WIDTH=390 pnpm exec tsx scripts/overflow.ts` */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://localhost:3190";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(process.env.WIDTH ?? 390), height: 800 } });
await page.goto(`${BASE}${process.env.PATH_ ?? "/dev/ui"}`, { waitUntil: "networkidle" });
const out = await page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const bad = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > w + 1);
  // The outermost offenders only: their children are consequences.
  return bad
    .filter((e) => !bad.includes(e.parentElement as Element))
    .map(
      (e) =>
        `${e.tagName.toLowerCase()}#${e.id}.${String(e.className).slice(0, 80)} w=${String(Math.round(e.getBoundingClientRect().width))} parent=${e.parentElement?.tagName.toLowerCase() ?? ""}.${String(e.parentElement?.className).slice(0, 60)} pw=${String(Math.round(e.parentElement?.getBoundingClientRect().width ?? 0))}`,
    );
});
console.warn(
  `viewport ${String(await page.evaluate(() => document.documentElement.clientWidth))}\n${out.join("\n")}`,
);
await browser.close();

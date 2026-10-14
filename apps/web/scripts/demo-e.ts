/* eslint-disable -- one-off marketing demo tooling, not product code (marketing/demo-2026-10/README.md) */
/** Demo part E: the one diagram that renders legibly, and the version diff. */
import { context, launch, readJson, shot, WEB } from "./demo-lib.js";

const c2 = readJson<{ idea2: string; c2v1: number; c2v2: number | null }>("case2.json");
const R = "case2-requirements";
const browser = await launch();
const ctx = await context(browser, { staff: "admin" });
const page = await ctx.newPage();
const v = c2.c2v2 ?? c2.c2v1;
await page.goto(`${WEB}/admin/requirements/${c2.idea2}/versions/${v}`);
await page.waitForTimeout(4000);
const seq = page.locator("main svg[aria-roledescription=sequence]").first();
await seq.scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, 120));
await shot(page, R, "07-diagram-sequence");

await page.evaluate(() => window.scrollTo(0, 0));
await page.getByRole("heading", { name: "Compare with" }).scrollIntoViewIfNeeded();
await page.locator("#compare-version").click();
await page.waitForTimeout(800);
await shot(page, R, "10-compare-menu");
const opts = await page
  .getByRole("option")
  .allInnerTexts()
  .catch(() => []);
console.log("menu:", opts.join(" | "));
const item = page.getByRole("option", { name: /^v1/ });
if ((await item.count()) > 0) {
  await item.click();
  await page.waitForTimeout(2500);
  await shot(page, R, "11-version-diff");
}
await browser.close();

/* eslint-disable -- one-off marketing demo tooling, not product code (marketing/demo-2026-10/README.md) */
/** Demo part C: one opportunity opened to its evidence quotes. */
import { context, launch, readJson, shot, WEB } from "./demo-lib.js";

const { campaignId } = readJson<{ campaignId: string }>("case1.json");
const browser = await launch();
const ctx = await context(browser, { staff: "admin" });
const page = await ctx.newPage();
await page.goto(`${WEB}/admin/campaigns/${campaignId}/results`);
await page.waitForTimeout(1500);
const btn = page.getByRole("button", { name: "Show details" }).nth(Number(process.env.NTH ?? 1));
await btn.click();
await page.waitForTimeout(1000);
console.log((await page.locator("main").innerText()).slice(1500, 6000));
const ev = page.getByText("Evidence").first();
await ev.scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, 200));
await shot(page, "case1-discovery", "14-opportunity-detail-with-evidence-quotes");
console.log((await page.locator("main").innerText()).slice(0, 200));
await browser.close();

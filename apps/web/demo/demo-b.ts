/* eslint-disable -- one-off marketing demo tooling, not product code (marketing/demo-2026-10/README.md) */
/** Demo part B: staff screens of case 1 (overview, campaign, analysis, report). */
import { writeFileSync } from "node:fs";
import { staffToken } from "../../../scripts/live-run/src/api.js";
import { API, context, launch, readJson, shot, STATE, WEB } from "./demo-lib.js";

const C = "case1-discovery";
const { campaignId } = readJson<{ campaignId: string }>("case1.json");
const { analysisId } = readJson<{ analysisId: string }>("case1-analysis.json");
const browser = await launch();
const ctx = await context(browser, { staff: "admin" });
const page = await ctx.newPage();
const scrollTo = async (text: string | RegExp, offset = 80): Promise<void> => {
  const el = page.getByText(text).first();
  await el.scrollIntoViewIfNeeded();
  await page.evaluate((o) => window.scrollBy(0, -o), offset);
};

await page.goto(`${WEB}/admin`);
await shot(page, C, "09-admin-overview");
await page.goto(`${WEB}/admin/campaigns/${campaignId}`);
await shot(page, C, "11-campaign-page");
await page.goto(`${WEB}/admin/campaigns/${campaignId}/results`);
await page.waitForTimeout(1500);
await shot(page, C, "12-results-summary-and-first-opportunity");
await scrollTo("17 opportunities");
await shot(page, C, "13-opportunity-list-by-solution-class");

// One opportunity opened up, with its evidence.
const card = page
  .locator("article, li, div")
  .filter({ hasText: "Digital Inventory Tracking System" })
  .filter({ has: page.getByRole("button", { name: "Show details" }) })
  .last();
await card.getByRole("button", { name: "Show details" }).first().click();
await page.waitForTimeout(800);
await card.scrollIntoViewIfNeeded();
await shot(page, C, "14-opportunity-detail-with-evidence-quotes");
await card.screenshot({ path: `${STATE}/card.png` });

await scrollTo("By department", 40);
await shot(page, C, "15-department-comparison");

await scrollTo("Where AI is not the answer", 40);
await shot(page, C, "16-where-ai-is-not-the-answer");

await page.goto(`${WEB}/admin/campaigns/${campaignId}/report`);
await page.waitForTimeout(1500);
await shot(page, C, "17-report-preview");
await page
  .getByRole("heading", { name: /Department comparison/ })
  .last()
  .scrollIntoViewIfNeeded();
await shot(page, C, "18-report-department-comparison-k-rule");
await page
  .getByRole("heading", { name: /Where AI is not/ })
  .last()
  .scrollIntoViewIfNeeded();
await shot(page, C, "19-report-where-ai-is-not-appropriate");

// The PDF, as the API serves it.
const { authSecret } = readJson<{ authSecret: string }>("demo-state.json");
const token = await staffToken("live-admin@example.test", authSecret);
const pdf = await fetch(`${API}/analyses/${analysisId}/report.pdf`, {
  headers: { authorization: `Bearer ${token}` },
});
console.log("pdf", pdf.status, pdf.headers.get("content-type"));
writeFileSync(`${STATE}/report.pdf`, Buffer.from(await pdf.arrayBuffer()));

// Dark theme and Finnish.
const dark = await context(browser, { staff: "admin", dark: true });
const dp = await dark.newPage();
await dp.goto(`${WEB}/admin/campaigns/${campaignId}/results`);
await shot(dp, C, "20-results-dark-theme");
const fi = await context(browser, { staff: "admin", locale: "fi" });
const fp = await fi.newPage();
await fp.goto(`${WEB}/admin`);
await shot(fp, C, "21-admin-overview-finnish");
await fp.goto(`${WEB}/admin/campaigns/${campaignId}/results`);
await shot(fp, C, "22-results-finnish");

// Analysis in progress: start a new run and catch it running.
await page.goto(`${WEB}/admin/campaigns/${campaignId}/results`);
await page.getByRole("button", { name: "Analyze now" }).click();
await page.waitForTimeout(2500);
await shot(page, C, "10-analysis-in-progress");
await browser.close();

/* eslint-disable -- one-off marketing demo tooling, not product code (marketing/demo-2026-10/README.md) */
/** Demo part F: the bridge, operator health, prompt administration, settings. */
import { context, launch, readJson, shot, WEB } from "./demo-lib.js";

const c2 = readJson<{ bridgeId: string; idea2: string }>("case2.json");
const browser = await launch();
const ctx = await context(browser, { staff: "admin" });
const page = await ctx.newPage();
await page.goto(`${WEB}/admin/requirements/${c2.bridgeId}`);
await page.waitForTimeout(3000);
console.log((await page.locator("main").innerText()).slice(0, 400).replace(/\n/g, " | "));
await shot(page, "case2-requirements", "12-bridge-requirement-from-discovery-opportunity");
await page.goto(`${WEB}/admin/requirements`);
await page.waitForTimeout(2500);
await shot(page, "case2-requirements", "01-requirements-list");

const op = await context(browser, { staff: "operator" });
const op1 = await op.newPage();
await op1.goto(`${WEB}/admin/operator/health`);
await op1.waitForTimeout(3000);
await shot(op1, "ops", "01-operator-health");
await op1.goto(`${WEB}/admin/operator/stats`);
await op1.waitForTimeout(2500);
await shot(op1, "ops", "02-operator-stats");

await page.goto(`${WEB}/admin/prompts`);
await page.waitForTimeout(2500);
await shot(page, "ops", "03-prompt-administration");
await page.goto(`${WEB}/admin/settings`);
await page.waitForTimeout(2500);
await shot(page, "ops", "04-settings");
await page.goto(`${WEB}/admin/routes`);
await page.waitForTimeout(2500);
await shot(page, "ops", "05-model-assignment");
await page.goto(`${WEB}/admin/audit`);
await page.waitForTimeout(2500);
await shot(page, "ops", "06-audit-log");

const dark = await context(browser, { staff: "admin", dark: true });
const dp = await dark.newPage();
await dp.goto(`${WEB}/admin/requirements/${c2.idea2}`);
await dp.waitForTimeout(3000);
await shot(dp, "case2-requirements", "13-requirements-workspace-dark");
const fi = await context(browser, { staff: "admin", locale: "fi" });
const fp = await fi.newPage();
await fp.goto(`${WEB}/admin/requirements/${c2.idea2}`);
await fp.waitForTimeout(3000);
await shot(fp, "case2-requirements", "14-requirements-workspace-finnish");
await browser.close();

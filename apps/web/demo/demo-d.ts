/* eslint-disable -- one-off marketing demo tooling, not product code (marketing/demo-2026-10/README.md) */
/** Demo part D: requirements workspace, version, diff, diagrams, downloads, bridge. */
import { writeFileSync } from "node:fs";
import { staffToken } from "../../../scripts/live-run/src/api.js";
import { API, context, launch, readJson, shot, STATE, WEB } from "./demo-lib.js";

const c2 = readJson<{ bridgeId: string; idea2: string; c2v1: number; c2v2: number | null }>("case2.json");
const R = "case2-requirements";
const browser = await launch();
const ctx = await context(browser, { staff: "admin" });
const page = await ctx.newPage();
const only = process.env.ONLY ?? "all";
const scrollToHeading = async (name: string | RegExp, nth: "first" | "last" = "first"): Promise<void> => {
  const h = page.getByRole("heading", { name });
  await (nth === "first" ? h.first() : h.last()).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -60));
};

if (only === "all" || only === "a") {
  await page.goto(`${WEB}/admin/requirements`);
  await page.waitForTimeout(2500);
  await shot(page, R, "01-requirements-list");
  await page.goto(`${WEB}/admin/requirements/${c2.idea2}`);
  await page.waitForTimeout(2000);
  await shot(page, R, "02-requirements-workspace");
  await scrollToHeading("Functional requirements");
  await shot(page, R, "03-workspace-functional-requirements");
  await page.getByRole("tab", { name: /Findings/ }).click();
  await page.waitForTimeout(1000);
  await shot(page, R, "04-workspace-findings-and-mvp-challenge");
}
if (only === "all" || only === "b") {
  await page.goto(`${WEB}/admin/requirements/${c2.idea2}/versions/${c2.c2v2 ?? c2.c2v1}`);
  await page.waitForTimeout(2000);
  await shot(page, R, "05-specification-version");
  await scrollToHeading("Functional requirements", "last");
  await shot(page, R, "06-requirement-detail-acceptance-criteria");
  await scrollToHeading(/Entity Relationship|System Context/, "first");
  await shot(page, R, "07-diagram");
  await scrollToHeading("Implementation phases", "last");
  await shot(page, R, "08-implementation-phases");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, R, "09-version-downloads-and-compare");
}
if (only === "all" || only === "c") {
  const { authSecret } = readJson<{ authSecret: string }>("demo-state.json");
  const token = await staffToken("live-admin@example.test", authSecret);
  const get = async (p: string, out: string): Promise<void> => {
    const r = await fetch(`${API}${p}`, { headers: { authorization: `Bearer ${token}` } });
    console.log(p, r.status, r.headers.get("content-type"));
    writeFileSync(`${STATE}/${out}`, Buffer.from(await r.arrayBuffer()));
  };
  const v = c2.c2v2 ?? c2.c2v1;
  await get(`/requirements/${c2.idea2}/versions/${v}/export.pdf`, "spec.pdf");
  await get(`/requirements/${c2.idea2}/versions/${v}/export?format=bundle`, "bundle.zip");
  await get(`/requirements/${c2.idea2}/versions/${v}/diff/${c2.c2v1}`, "diff.json");
}
await browser.close();

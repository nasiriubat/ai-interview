/**
 * Marketing demo, case 1 part 2: waits for extraction, runs a fresh analysis on the settled facts
 * and prints what it found (counts and titles only).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Api, staffToken } from "./api.js";
import { sleep } from "./runtime.js";
import { ADMIN_EMAIL } from "./stack.js";

const state = JSON.parse(readFileSync(process.env.DEMO_STATE ?? "", "utf8")) as { authSecret: string };
const c1 = JSON.parse(readFileSync("/private/tmp/claude-504/d/case1.json", "utf8")) as { campaignId: string };
const admin = new Api("admin", await staffToken(ADMIN_EMAIL, state.authSecret));

interface A {
  id: string;
  status: string;
  version: number;
  stats: Record<string, unknown>;
}
const list = async (): Promise<A[]> =>
  (await admin.ok<{ analyses: A[] }>("GET", `/campaigns/${c1.campaignId}/analyses`)).analyses;

// let extraction settle
await sleep(20_000);
const before = await list();
console.warn("existing analyses", JSON.stringify(before.map((a) => [a.version, a.status, a.stats.facts])));
const started = await admin.ok<{ analysis: A }>("POST", `/campaigns/${c1.campaignId}/analyses`, {});
let latest: A | undefined;
for (;;) {
  await sleep(5000);
  latest = (await list()).find((a) => a.id === started.analysis.id);
  if (latest && (latest.status === "done" || latest.status === "failed")) break;
}
console.warn("analysis", latest.status, JSON.stringify(latest.stats));
const detail = await admin.ok<{
  opportunities: { id: string; title: string; solutionClass: string; rankScore: number }[];
}>("GET", `/analyses/${latest.id}`);
for (const o of detail.opportunities) console.warn(` - ${o.id} ${o.solutionClass} ${o.rankScore} ${o.title}`);
writeFileSync(
  "/private/tmp/claude-504/d/case1-analysis.json",
  JSON.stringify({ analysisId: latest.id, opportunities: detail.opportunities }, null, 2),
);
const spend = await admin.ok<{ rows: { costCents: number }[] }>("GET", "/spend?groupBy=purpose");
console.warn("ledger cents", spend.rows.reduce((s, r) => s + r.costCents, 0).toFixed(1));

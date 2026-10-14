/**
 * Marketing demo, case 1 part 1: routing, a campaign and eight simulated colleagues over the API.
 * The ninth interview is taken in a browser by apps/web/scripts/demo-shots.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Api, staffToken } from "./api.js";
import { DEMO_PERSONAS } from "./demo-personas.js";
import { runInterview } from "./interview.js";
import { configureRouting } from "./routing.js";
import { harnessSpend, loadOpenRouterKey, log, mapLimit } from "./runtime.js";
import { ADMIN_EMAIL, OPERATOR_EMAIL } from "./stack.js";

const state = JSON.parse(readFileSync(process.env.DEMO_STATE ?? "", "utf8")) as { authSecret: string };
const operator = new Api("operator", await staffToken(OPERATOR_EMAIL, state.authSecret));
const admin = new Api("admin", await staffToken(ADMIN_EMAIL, state.authSecret));
const key = loadOpenRouterKey();

const routing = await configureRouting(operator, admin);
const sim = { apiKey: key, model: routing.simulatorModel.id };

const { templates } = await admin.ok<{ templates: { id: string; key: string; version: number }[] }>(
  "GET",
  "/templates",
);
const template = templates
  .filter((t) => t.key === "opportunity_discovery")
  .sort((a, b) => b.version - a.version)[0];
if (!template) throw new Error("template missing");
const created = await admin.ok<{ campaign: { id: string }; link: { url: string } }>("POST", "/campaigns", {
  templateId: template.id,
  name: "Where does our time go? Clinic network discovery",
  participationMode: "participant_choice",
  verification: "open",
  maxTurns: 14,
  completionThreshold: DEMO_PERSONAS.length,
});
const campaignId = created.campaign.id;
const linkToken = created.link.url.split("/p/")[1] ?? "";
await admin.ok("POST", `/campaigns/${campaignId}/open`);
writeFileSync(
  "/private/tmp/claude-504/d/case1.json",
  JSON.stringify({ campaignId, linkToken, templateId: template.id }, null, 2),
);
log(`campaign ${campaignId} open`);

const ids = (process.env.DEMO_PERSONAS ?? "").split(",").filter(Boolean);
const personas = DEMO_PERSONAS.filter((p) => (ids.length ? ids.includes(p.id) : p.id !== "nur_1"));
const results = await mapLimit(personas, 3, async (persona, index) => {
  try {
    const r = await runInterview({ linkToken, persona, sim, maxTurns: 14, index });
    return { id: persona.id, turns: r.turns.length, ended: r.ended, reason: r.endReason, notes: r.notes };
  } catch (err) {
    return { id: persona.id, error: err instanceof Error ? err.message : String(err) };
  }
});
log(JSON.stringify(results));
log(`harness spend (simulator) so far: $${harnessSpend.usd.toFixed(3)}`);
const spend = await admin.ok<{ rows: { costCents: number }[] }>("GET", "/spend?groupBy=purpose");
log(`ledger cents: ${spend.rows.reduce((s, r) => s + r.costCents, 0).toFixed(1)}`);

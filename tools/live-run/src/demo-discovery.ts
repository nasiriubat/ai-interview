/**
 * Marketing demo, a discovery campaign (DEMO_CASE: ops, billing or handover; `demo-state.ts`) and
 * its simulated colleagues over the API. On OpenRouter the routes are chosen by `routing.ts`; on
 * Meta's Model API the bootstrap's default routes are used as they stand, as a deployment would.
 */
import { Api, staffToken } from "./api.js";
import { harnessBackend } from "./backend.js";
import { DEMO_PERSONAS } from "./demo-personas.js";
import { DEMO_CASES, demoCase, readStackState, writeDemo } from "./demo-state.js";
import { runInterview } from "./interview.js";
import { configureRouting } from "./routing.js";
import { harnessSpend, log, mapLimit, TENANT_BUDGET_CENTS } from "./runtime.js";
import { ADMIN_EMAIL, OPERATOR_EMAIL } from "./stack.js";

const state = readStackState();
const operator = new Api("operator", await staffToken(OPERATOR_EMAIL, state.authSecret));
const admin = new Api("admin", await staffToken(ADMIN_EMAIL, state.authSecret));
const backend = harnessBackend();
const which = demoCase();
const spec = DEMO_CASES[which];

let sim = backend.sim;
if (backend.provider === "openrouter") {
  const routing = await configureRouting(operator, admin);
  sim = { apiKey: backend.sim.apiKey, model: routing.simulatorModel.id };
} else {
  // The tenant cap through the product's own budget feature, as an admin would set it (an upsert).
  await admin.ok("POST", "/budgets", { scope: "tenant", limitCents: TENANT_BUDGET_CENTS, period: "month" });
}

const { templates } = await admin.ok<{ templates: { id: string; key: string; version: number }[] }>(
  "GET",
  "/templates",
);
const template = templates
  .filter((t) => t.key === "opportunity_discovery")
  .sort((a, b) => b.version - a.version)[0];
if (!template) throw new Error("template missing");
const people = DEMO_PERSONAS.filter((p) => (spec.personas as readonly string[]).includes(p.id));
const created = await admin.ok<{ campaign: { id: string }; link: { url: string } }>("POST", "/campaigns", {
  templateId: template.id,
  name: spec.name,
  participationMode: "participant_choice",
  verification: "open",
  maxTurns: 14,
  completionThreshold: people.length,
});
const campaignId = created.campaign.id;
await admin.ok("PUT", `/settings?scope=campaign&scopeId=${campaignId}`, {
  values: { "campaign.welcomeText": spec.welcome },
});
const linkToken = created.link.url.split("/p/")[1] ?? "";
await admin.ok("POST", `/campaigns/${campaignId}/open`);
writeDemo(`case-${which}.json`, { campaignId, linkToken, templateId: template.id });
log(`${which}: campaign ${campaignId} open, ${people.length} colleagues`);

const results = await mapLimit(people, Number(process.env.DEMO_CONCURRENCY ?? 3), async (persona, index) => {
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

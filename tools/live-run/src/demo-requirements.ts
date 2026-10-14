/**
 * Marketing demo, case 1 bridge and case 2: two requirements interviews played by the simulator
 * (one started from a discovered opportunity, one from a one-sentence idea), each with a version;
 * the second is reopened and revised so there is a diff to show.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Api, staffToken } from "./api.js";
import { generateVersion, ownerSystemPrompt, runRequirementsTurns, type Handoff } from "./requirements.js";
import { harnessSpend, loadOpenRouterKey, log } from "./runtime.js";
import { ADMIN_EMAIL, OPERATOR_EMAIL } from "./stack.js";

const state = JSON.parse(readFileSync(process.env.DEMO_STATE ?? "", "utf8")) as { authSecret: string };
const a = JSON.parse(readFileSync("/private/tmp/claude-504/d/case1-analysis.json", "utf8")) as {
  opportunities: { id: string; title: string }[];
};
const admin = new Api("admin", await staffToken(ADMIN_EMAIL, state.authSecret));
const operator = new Api("operator", await staffToken(OPERATOR_EMAIL, state.authSecret));
const sim = { apiKey: loadOpenRouterKey(), model: "qwen/qwen3-30b-a3b-instruct-2507" };

const { templates } = await admin.ok<{ templates: { id: string; key: string; version: number }[] }>(
  "GET",
  "/templates",
);
const reqTemplate = templates
  .filter((t) => t.key === "requirements_discovery")
  .sort((x, y) => y.version - x.version)[0];
if (reqTemplate)
  await operator.ok("PUT", `/settings?scope=template&scopeId=${reqTemplate.id}`, {
    values: { "engine.maxTurns": 36 },
  });

const swap = (s: string): string =>
  s
    .replace(
      "Helena, a ward operations manager at a regional hospital group",
      "Helena, the operations manager of a regional clinic network",
    )
    .replace("the hospital group's IT department", "the clinic network's IT department");

// ---- bridge: promote the stock-counting opportunity
// The demo analysis varies between runs, so fall back to the first opportunity when the named one is absent.
const opp =
  a.opportunities.find((o) => o.title.startsWith("Digital Inventory Tracking")) ?? a.opportunities[0];
if (!opp) throw new Error("opportunity not found");
const promoted = await admin.ok<{ session: { id: string }; handoff: Handoff }>(
  "POST",
  `/opportunities/${opp.id}/promote`,
  {},
);
const bridgeId = promoted.session.id;
await admin.ok("POST", `/requirements/${bridgeId}/path`, { path: "nontechnical" });
const system1 = swap(ownerSystemPrompt("nontechnical", opp.title, promoted.handoff));
const run1 = await runRequirementsTurns({
  api: admin,
  sessionId: bridgeId,
  kind: "nontechnical",
  system: system1,
  sim,
  maxTurns: 30,
  label: "sim:bridge_owner",
});
const v1 = await generateVersion(admin, bridgeId, "From the discovery opportunity", 20 * 60_000);
log(`bridge: ${run1.turns.length} turns, version ${v1.version} ${v1.status}`);

// ---- case 2: a one-sentence idea
const idea =
  "Parking Pass: a small web tool where clinic visitors and contractors register their car for the day, and reception can see who is on site and who has overstayed.";
const created = await admin.ok<{ session: { id: string } }>("POST", "/requirements", {
  title: "Parking Pass",
  prompt: idea,
  path: "nontechnical",
});
const idea2 = created.session.id;
const system2 = swap(ownerSystemPrompt("nontechnical", "Parking Pass", null)).replace(
  "You have only the one-paragraph idea described above",
  `The idea: ${idea}. You have only that sentence`,
);
const run2 = await runRequirementsTurns({
  api: admin,
  sessionId: idea2,
  kind: "nontechnical",
  system: system2,
  sim,
  maxTurns: 30,
  label: "sim:idea_owner",
});
const c2v1 = await generateVersion(admin, idea2, "First specification", 20 * 60_000);
log(`idea: ${run2.turns.length} turns, version ${c2v1.version} ${c2v1.status}`);
const reopen = await admin.call("POST", `/requirements/${idea2}/reopen`);
let c2v2: { version: number; status: string } | null = null;
if (reopen.status === 200) {
  await runRequirementsTurns({
    api: admin,
    sessionId: idea2,
    kind: "nontechnical",
    system: system2,
    sim,
    maxTurns: 5,
    startIndex: run2.turns.length,
    label: "sim:idea_owner_rev",
    nudge:
      "You have had second thoughts. Change one earlier decision to something different and say why, and add one requirement you forgot, for example an audit trail or a daily export.",
  });
  c2v2 = await generateVersion(admin, idea2, "After a second thought", 20 * 60_000);
}
writeFileSync(
  "/private/tmp/claude-504/d/case2.json",
  JSON.stringify(
    { bridgeId, bridgeVersion: v1.version, idea2, c2v1: c2v1.version, c2v2: c2v2?.version ?? null },
    null,
    2,
  ),
);
log(`harness spend $${harnessSpend.usd.toFixed(3)}; case2 v2 ${JSON.stringify(c2v2)}`);
const spend = await admin.ok<{ rows: { costCents: number }[] }>("GET", "/spend?groupBy=purpose");
log(`ledger cents ${spend.rows.reduce((s, r) => s + r.costCents, 0).toFixed(1)}`);

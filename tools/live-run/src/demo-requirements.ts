/**
 * Marketing demo, three requirements interviews played by the simulator: two started from
 * discovered opportunities (the `ops` and `billing` campaigns, when their analyses exist) and one
 * from a one-sentence idea, which is then reopened and revised so there is a diff to show.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Api, staffToken } from "./api.js";
import { harnessBackend } from "./backend.js";
import { demoDir, readDemo, readStackState, writeDemo } from "./demo-state.js";
import { generateVersion, ownerSystemPrompt, runRequirementsTurns, type Handoff } from "./requirements.js";
import { harnessSpend, log } from "./runtime.js";
import { ADMIN_EMAIL, OPERATOR_EMAIL } from "./stack.js";

const state = readStackState();
const admin = new Api("admin", await staffToken(ADMIN_EMAIL, state.authSecret));
const operator = new Api("operator", await staffToken(OPERATOR_EMAIL, state.authSecret));
const sim = harnessBackend().sim;
const GENERATE_MS = 20 * 60_000;

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

const out: Record<string, unknown> = {};

/** A requirements interview started from the top opportunity of one campaign's analysis. */
async function fromOpportunity(which: string, prefer: RegExp): Promise<void> {
  if (!existsSync(join(demoDir(), `case-${which}-analysis.json`))) {
    log(`${which}: no analysis yet, skipped`);
    return;
  }
  const a = readDemo(`case-${which}-analysis.json`) as {
    opportunities: { id: string; title: string; solutionClass: string }[];
  };
  const opp = a.opportunities.find((o) => prefer.test(o.title)) ?? a.opportunities[0];
  if (!opp) throw new Error(`${which}: the analysis found no opportunity`);
  const promoted = await admin.ok<{ session: { id: string }; handoff: Handoff }>(
    "POST",
    `/opportunities/${opp.id}/promote`,
    {},
  );
  const id = promoted.session.id;
  await admin.ok("POST", `/requirements/${id}/path`, { path: "nontechnical" });
  const run = await runRequirementsTurns({
    api: admin,
    sessionId: id,
    kind: "nontechnical",
    system: swap(ownerSystemPrompt("nontechnical", opp.title, promoted.handoff)),
    sim,
    maxTurns: 30,
    label: `sim:${which}_owner`,
  });
  const v = await generateVersion(admin, id, "From the discovery opportunity", GENERATE_MS);
  out[which] = { sessionId: id, opportunity: opp.title, version: v.version, status: v.status };
  log(`${which}: "${opp.title}", ${run.turns.length} turns, version ${v.version} ${v.status}`);
}

await fromOpportunity("ops", /inventory|stock|supplies|booking/i);
await fromOpportunity("billing", /invoice|claim|reconcil/i);

// ---- a one-sentence idea, then a second thought
const idea =
  "Parking Pass: a small web tool where clinic visitors and contractors register their car for the day, and reception can see who is on site and who has overstayed.";
const created = await admin.ok<{ session: { id: string } }>("POST", "/requirements", {
  title: "Parking Pass",
  prompt: idea,
  path: "nontechnical",
});
const ideaId = created.session.id;
const system = swap(ownerSystemPrompt("nontechnical", "Parking Pass", null)).replace(
  "You have only the one-paragraph idea described above",
  `The idea: ${idea}. You have only that sentence`,
);
const run = await runRequirementsTurns({
  api: admin,
  sessionId: ideaId,
  kind: "nontechnical",
  system,
  sim,
  maxTurns: 30,
  label: "sim:idea_owner",
});
const v1 = await generateVersion(admin, ideaId, "First specification", GENERATE_MS);
log(`idea: ${run.turns.length} turns, version ${v1.version} ${v1.status}`);
const reopen = await admin.call("POST", `/requirements/${ideaId}/reopen`);
let v2: { version: number; status: string } | null = null;
if (reopen.status === 200) {
  await runRequirementsTurns({
    api: admin,
    sessionId: ideaId,
    kind: "nontechnical",
    system,
    sim,
    maxTurns: 5,
    startIndex: run.turns.length,
    label: "sim:idea_owner_rev",
    nudge:
      "You have had second thoughts. Change one earlier decision to something different and say why, and add one requirement you forgot, for example an audit trail or a daily export.",
  });
  v2 = await generateVersion(admin, ideaId, "After a second thought", GENERATE_MS);
}
out.idea = { sessionId: ideaId, v1: v1.version, v2: v2?.version ?? null };
writeDemo("requirements.json", out);
log(`harness spend $${harnessSpend.usd.toFixed(3)}; idea v2 ${JSON.stringify(v2)}`);
const spend = await admin.ok<{ rows: { costCents: number }[] }>("GET", "/spend?groupBy=purpose");
log(`ledger cents ${spend.rows.reduce((s, r) => s + r.costCents, 0).toFixed(1)}`);

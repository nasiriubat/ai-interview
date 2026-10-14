#!/usr/bin/env node
// Points the platform at the fake provider, the way an operator would: signs in as the platform
// operator through the real magic-link flow, creates an OpenAI-compatible provider, prices it and
// routes every purpose to it; then signs in as the tenant admin, creates an open campaign and
// publishes its link.
//
//   tools/rehearsal/drill/stack.sh run node tools/rehearsal/drill/configure.mjs
//
// Writes $AIDP_DRILL_DIR/campaign.json ({ campaignId, linkToken, templateId, campaigns: [{ campaignId, linkToken }] }) for the other drill
// scripts and the k6 scenarios. Idempotent enough to run twice: an existing provider is reused.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_EMAIL, BASE, OPERATOR_EMAIL, log, signIn, staff } from "./lib.mjs";

const FAKE_URL_IN_NETWORK = process.env.AIDP_FAKE_URL_IN_NETWORK ?? "http://fake-provider:4010/v1";
const dir = process.env.AIDP_DRILL_DIR;

const ROUTES = [
  ["interview_turn", "fake-fast", 2048],
  ["resume_summary", "fake-structured", 2048],
  ["extraction", "fake-structured", 4096],
  ["issue_detection", "fake-structured", 4096],
  ["file_ingest", "fake-structured", 4096],
  ["vision_ingest", "fake-structured", 4096],
  ["clustering", "fake-strong", 8000],
  ["analysis_report", "fake-strong", 8000],
  ["spec_turn", "fake-strong", 2048],
  ["spec_generation", "fake-strong", 16000],
  ["transcription", "fake-transcribe", 512],
  ["stt_stream", "fake-transcribe", 512],
  ["tts", "fake-speech", 512],
];

log(`configuring ${BASE}`);
const operator = await signIn(OPERATOR_EMAIL, "operator");
log("operator signed in through the magic link");

const existing = await staff(operator, "GET", "/operator/providers");
let provider = existing.providers.find((p) => p.companyId === null && p.name === "Fake provider (drill)");
if (!provider) {
  const created = await staff(operator, "POST", "/operator/providers", {
    kind: "openai_compatible",
    name: "Fake provider (drill)",
    baseUrl: FAKE_URL_IN_NETWORK,
    apiKey: "fake-key-not-a-secret",
  });
  provider = created.provider ?? created;
  log(`created provider ${provider.id}`);
}
const models = ["fake-fast", "fake-structured", "fake-strong", "fake-transcribe", "fake-speech"];
await staff(operator, "PUT", `/operator/providers/${provider.id}/prices`, {
  prices: models.map((model) => ({ model, inputPerMtok: 0.5, outputPerMtok: 1.5 })),
});
await staff(operator, "PUT", "/operator/routes", {
  routes: ROUTES.map(([purpose, model, maxOutputTokens]) => ({
    purpose,
    providerId: provider.id,
    model,
    maxOutputTokens,
    batchAllowed: false,
  })),
});
log(`routed ${ROUTES.length} purposes to the fake provider`);

const test = await staff(operator, "POST", `/operator/providers/${provider.id}/test`, { model: "fake-fast" });
log(`provider test: ${JSON.stringify(test).slice(0, 160)}`);

// A load run starts a few hundred interviews, and the tenant's default ceiling is 1000 a month
// (ceiling.maxSessionsPerMonth). The first 4 GB-limits run hit it: the product refused every open
// with limit_reached, correctly. The rehearsal platform has no monthly ceiling; a real one keeps its
// own.
//
// The abuse limits on open links (D-261, D-310) are NOT raised by default: the second drill runs
// the load against the defaults, with the traffic spread over several campaigns the way a launch is,
// to see whether legitimate people are refused. AIDP_DRILL_RAISE_ABUSE=1 raises them to their
// maximum for a pure capacity run (the single-address control, tools/load/k6/single-ip.js, is about the
// per-address limiter and does not depend on them).
const raiseAbuse = process.env.AIDP_DRILL_RAISE_ABUSE === "1";
await staff(operator, "PUT", "/settings?scope=platform", {
  values: {
    "ceiling.maxSessionsPerMonth": 0,
    "ceiling.voiceMinutes": 0,
    ...(raiseAbuse
      ? {
          "abuse.campaignSessionsPerHour": 100000,
          "abuse.campaignSessionsTotal": 1000000,
          "abuse.tenantSessionsPerHour": 100000,
        }
      : {}),
  },
});
log(
  `platform monthly ceilings removed; abuse limits ${raiseAbuse ? "raised to their maximum" : "left at their defaults"}`,
);
const admin = await signIn(ADMIN_EMAIL, "admin");
log("tenant admin signed in");
// Live voice is off until a tenant turns it on (features.realtimeVoice, default false).
await staff(admin, "PUT", "/settings?scope=tenant", { values: { "features.realtimeVoice": true } });
log("tenant setting features.realtimeVoice = true");
const templates = await staff(admin, "GET", "/templates");
const template = templates.templates
  .filter((t) => t.key === "opportunity_discovery")
  .sort((a, b) => b.version - a.version)[0];
if (!template) throw new Error("opportunity_discovery template not found");
// Several campaigns, as a launch is: a company runs a few at once (CAMPAIGNS, default 3). The
// first is the one the journey, the chaos scripts and the single-address control use.
const COUNT = Math.max(1, Number(process.env.CAMPAIGNS ?? 3));
const campaigns = [];
for (let i = 1; i <= COUNT; i += 1) {
  const created = await staff(admin, "POST", "/campaigns", {
    templateId: template.id,
    name: `Drill: full-stack discovery ${i}`,
    participationMode: "participant_choice",
    verification: "open",
    maxTurns: 20,
    completionThreshold: 3,
  });
  const campaignId = created.campaign.id;
  const linkToken = created.link.url.split("/p/")[1];
  await staff(admin, "POST", `/campaigns/${campaignId}/open`);
  log(`campaign ${i} of ${COUNT} open (${campaignId}), link token ${linkToken.slice(0, 4)}...`);
  campaigns.push({ campaignId, linkToken });
}
const [{ campaignId, linkToken }] = campaigns;
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "campaign.json"),
    JSON.stringify({ campaignId, linkToken, templateId: template.id, campaigns }),
  );
}

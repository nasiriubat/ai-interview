#!/usr/bin/env node
// What a participant would have seen while something was done to the stack: polls the sign-in page
// through Caddy every 250 ms (web and Caddy), and the campaign link every 2.5 s (API and database;
// the route allows 30 a minute per address), and reports the sequence of answers, so "maintenance
// page, not a proxy error" is a fact with a duration.
//
//   deploy/drill/stack.sh run node deploy/drill/probe.mjs 60 > /tmp/probe.json &   # seconds
//   ... run the upgrade, the rollback, the chaos ...
//   wait; cat /tmp/probe.json
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, sleep } from "./lib.mjs";

const seconds = Number(process.argv[2] ?? 60);
const dir = process.env.AIDP_DRILL_DIR;
const { linkToken } = JSON.parse(readFileSync(join(dir, "campaign.json"), "utf8"));
const urls = { web: `${BASE}/auth/signin`, link: `${BASE}/api/participant/p/${linkToken}` };
const runsBy = { web: [], link: [] };
const started = Date.now();
let total = 0;
let tick = 0;
const probe = async (name) => {
  const runs = runsBy[name];
  let code;
  const t = Date.now();
  try {
    const res = await fetch(urls[name], { signal: AbortSignal.timeout(5000) });
    code = String(res.status);
    if (res.status === 503) {
      const text = await res.text();
      if (text.includes("Back in a minute")) code = "503-maintenance";
    } else await res.arrayBuffer();
  } catch (e) {
    code = `error:${e.cause?.code ?? e.name}`;
  }
  total++;
  const last = runs.at(-1);
  if (last && last.code === code) {
    last.count++;
    last.until = t;
  } else runs.push({ code, count: 1, from: t, until: t });
};
while (Date.now() - started < seconds * 1000) {
  const jobs = [probe("web")];
  if (tick % 10 === 0) jobs.push(probe("link"));
  await Promise.all(jobs);
  tick++;
  await sleep(250);
}
const out = {};
for (const [name, runs] of Object.entries(runsBy)) {
  const summary = runs.map((r) => ({
    code: r.code,
    count: r.count,
    startOffsetS: +((r.from - started) / 1000).toFixed(1),
    durationS: +((r.until - r.from) / 1000).toFixed(1),
  }));
  out[name] = {
    runs: summary,
    outsideMaintenance: summary.filter((r) => r.code !== "200" && r.code !== "503-maintenance"),
  };
}
console.log(JSON.stringify({ total, ...out }, null, 1));

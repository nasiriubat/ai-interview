// The scenarios, one exported function each; smoke.js and full.js choose among them.
import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";
import {
  BASE,
  THINK_MAX,
  THINK_MIN,
  interview,
  linkFor,
  linkOpenErrors,
  linkOpens,
  note5xx,
  opened200,
  throttled,
} from "./lib.js";
import { voiceSession } from "./voice.js";

export { voiceSession };

const TURNS = Number(__ENV.INTERVIEW_TURNS || 20);
export const adminErrors = new Rate("admin_errors");

/** One participant, a whole interview with think time between answers. */
export function participant() {
  interview(TURNS);
}

/** A campaign launch: someone opens the link. No interview follows; the cost is the open itself. */
export function launchBurst() {
  const t0 = Date.now();
  // Spread over the campaigns of the run, round-robin by arrival.
  const link = linkFor(exec.scenario.iterationInTest);
  const landing = http.get(`${BASE}/api/participant/p/${link}`, { tags: { name: "link" } });
  note5xx(landing);
  if (landing.status === 429) throttled.add(1);
  const opened = http.post(`${BASE}/api/participant/p/${link}/open`, "{}", {
    headers: { "Content-Type": "application/json" },
    tags: { name: "open" },
  });
  note5xx(opened);
  if (opened.status === 429) throttled.add(1);
  if (opened.status === 200) opened200.add(1);
  linkOpens.add(Date.now() - t0);
  const ok = check(opened, { "burst: link opened": (r) => r.status === 200 });
  linkOpenErrors.add(!ok);
}

/** The admin looks at the dashboards while interviews run. */
export function adminReads() {
  const cookie = __ENV.ADMIN_COOKIE || "";
  const params = { headers: { Cookie: cookie }, tags: { name: "admin" } };
  const campaignId = __ENV.CAMPAIGN_ID || "";
  const paths = [
    "/api/staff/stats",
    "/api/staff/campaigns",
    "/api/staff/stats/participation",
    "/api/staff/spend/budgets",
  ];
  if (campaignId) {
    paths.push(`/api/staff/campaigns/${campaignId}`, `/api/staff/campaigns/${campaignId}/sessions`);
  }
  for (const path of paths) {
    const res = http.get(`${BASE}${path}`, params);
    note5xx(res);
    adminErrors.add(!check(res, { "admin read ok": (r) => r.status === 200 }));
    sleep(1 + Math.random());
  }
  sleep(THINK_MIN);
}

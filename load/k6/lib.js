// Shared by the k6 scenarios. Run through load/run.sh, which supplies the environment:
//
//   BASE_URL      https://aidp.localhost:18443 (the drill stack, through Caddy)
//   LINK_TOKEN    an open campaign's link token (deploy/drill/configure.mjs writes it)
//   ADMIN_COOKIE  the tenant admin's session cookie, "name=value" (deploy/drill/session.mjs)
//   THINK_MIN / THINK_MAX   seconds a participant takes to answer (default 3 to 8)
//
// Everything goes through the front door: the same URLs a browser calls, the same cookies.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// A WebSocket upgrade answers 101, which k6 would count as a failed request. 429 is not expected:
// a run that gets rate limited has found something and should say so.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 101));

export const BASE = __ENV.BASE_URL || "https://aidp.localhost:18443";
export const LINK = __ENV.LINK_TOKEN || "";
export const THINK_MIN = Number(__ENV.THINK_MIN || 3);
export const THINK_MAX = Number(__ENV.THINK_MAX || 8);

/** Time to the first byte of the SSE response. The API writes the stream's headers when the first
 * event is ready (turn-runner.ts), so this is the participant's first-token time, through Caddy and
 * the web proxy, which is what the target is about. */
export const firstToken = new Trend("first_token_ms", true);
export const turnTotal = new Trend("turn_total_ms", true);
export const turnErrors = new Rate("turn_errors");
export const interviewsCompleted = new Counter("interviews_completed");
export const linkOpens = new Trend("link_open_ms", true);
export const linkOpenErrors = new Rate("link_open_errors");
export const fiveHundreds = new Counter("http_5xx");

const ANSWERS = [
  "I am a ward clerk on a cardiology ward. Most of my day is keeping bed status current.",
  "We print the list, write changes on it by hand, then type everything in again at the end of the shift.",
  "It takes about forty minutes every shift and mistakes slip in. Last week a bed was shown free when it was not.",
  "The tools are a shared spreadsheet and the hospital system, which do not talk to each other.",
  "Nurses ask me the same question about discharges many times a day, usually by phone.",
  "If one screen showed the status for the whole ward, most of that would go away.",
  "I would worry about patient data. It must stay inside the hospital network.",
  "That is about everything I can think of right now.",
];

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Counts a 5xx wherever it happens, so "no 5xx" is one number. */
export function note5xx(res) {
  if (res.status >= 500) fiveHundreds.add(1);
}

export function think() {
  sleep(THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN));
}

/** The participant's arrival: the link, the cookie, consent. Returns true when a session exists. */
export function arrive(name) {
  const t0 = Date.now();
  const landing = http.get(`${BASE}/api/participant/p/${LINK}`, { tags: { name: "link" } });
  note5xx(landing);
  const opened = http.post(`${BASE}/api/participant/p/${LINK}/open`, "{}", {
    headers: JSON_HEADERS,
    tags: { name: "open" },
  });
  note5xx(opened);
  linkOpens.add(Date.now() - t0);
  const ok = check(opened, { "link opened": (r) => r.status === 200 });
  linkOpenErrors.add(!ok);
  if (!ok) return false;
  let consentVersion = "v1";
  try {
    consentVersion = landing.json("campaign.consentVersion") || "v1";
  } catch (_) {
    // the default stands
  }
  const consent = http.post(
    `${BASE}/api/participant/p/session/consent`,
    JSON.stringify({
      consentVersion,
      participantFields: { name },
      participationChoice: "anonymous",
    }),
    { headers: JSON_HEADERS, tags: { name: "consent" } },
  );
  note5xx(consent);
  return check(consent, { "consent given": (r) => r.status === 200 });
}

/** One turn. `index` 0 is the opening turn with no body, as the client sends it. */
export function takeTurn(index) {
  const body =
    index === 0 ? null : JSON.stringify({ content: ANSWERS[(index - 1) % ANSWERS.length], modality: "text" });
  const res = http.post(`${BASE}/api/participant/p/session/turns`, body, {
    headers: index === 0 ? {} : JSON_HEADERS,
    tags: { name: "turn" },
    timeout: "60s",
  });
  note5xx(res);
  const ended = /event: turn\ndata: .*"ended":true/.test(res.body || "");
  const hasTurn = (res.body || "").includes("event: turn");
  const failed = res.status !== 200 || !hasTurn || (res.body || "").includes("event: error");
  turnErrors.add(failed);
  if (!failed) {
    firstToken.add(res.timings.waiting);
    turnTotal.add(res.timings.duration);
  }
  return { failed, ended };
}

/** A whole interview: arrive, then `turns` turns (or until it ends) with think time between. */
export function interview(turns) {
  if (!arrive(`k6-${__VU}-${__ITER}`)) return;
  for (let i = 0; i < turns; i++) {
    const t = takeTurn(i);
    if (t.failed) return;
    if (t.ended) {
      interviewsCompleted.add(1);
      return;
    }
    think();
  }
  interviewsCompleted.add(1);
}

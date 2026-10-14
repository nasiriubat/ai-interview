// The negative control for the launch burst. 200 link opens inside a minute, and every one from the
// same address (a single VU's local IP: k6 --local-ips rotates by VU, so one VU keeps one address).
// The link routes allow 120 a minute per client address (RATE_LIMIT_PUBLIC_MAX, D-310), so this MUST be rate limited: if it is not,
// the burst's "no errors from 100 distinct addresses" proves nothing, because the limiter would not
// have been looking at the client address at all.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { BASE, LINK } from "./lib.js";

const limited = new Counter("single_ip_limited");
const accepted = new Counter("single_ip_accepted");
const OPENS = Number(__ENV.SINGLE_IP_OPENS || 200);

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    one_address: { executor: "per-vu-iterations", vus: 1, iterations: OPENS, maxDuration: "90s" },
  },
  thresholds: {
    // Some must pass (the limit is 120), and the rest must be refused.
    single_ip_accepted: ["count>=20"],
    single_ip_limited: ["count>=10"],
  },
};

export default function () {
  const res = http.get(`${BASE}/api/participant/p/${LINK}`, { tags: { name: "link-single" } });
  if (res.status === 429) limited.add(1);
  else if (res.status === 200) accepted.add(1);
  check(res, { "answered 200 or 429, never 5xx": (r) => r.status === 200 || r.status === 429 });
}

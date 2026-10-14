// A diagnostic, not a gate: how long does a first connection from a fresh client address take, and
// a second one from the same address? 100 VUs, three requests each, no connection reuse.
// Run through `tools/load/run.sh connect`. It exists because the launch burst once showed TCP connect
// times of 9 to 11 seconds that were nothing to do with the application.
import http from "k6/http";
import { Trend } from "k6/metrics";
import { BASE } from "./lib.js";

const first = new Trend("connect_first_ms", true);
const later = new Trend("connect_later_ms", true);

export const options = {
  insecureSkipTLSVerify: true,
  noConnectionReuse: true,
  scenarios: {
    fresh: { executor: "per-vu-iterations", vus: Number(__ENV.VUS || 100), iterations: 3, maxDuration: "2m" },
  },
};

export default function () {
  const res = http.get(`${BASE}/auth/signin`, { tags: { name: "signin" } });
  (__ITER === 0 ? first : later).add(res.timings.connecting);
}

// An announcement in a company chat: OFFICE_PEOPLE colleagues (default 40) behind ONE office
// address click the same link within OFFICE_MINUTES (default 2). Every one of them is a legitimate
// participant, so the result that matters is `legit_throttled`: how many of them were turned away by
// a per-address limit that sees one client (D-310). The negative control, single-ip.js, shows the
// limiter works at all; this one shows what it costs real people behind a shared address.
//
// One virtual user is one source address in load/run.sh (k6 --local-ips), so the whole office is one
// VU taking its colleagues in turn at random spacing. Each person lands on the link, opens it and
// consents, like a browser does (three requests, two of them on the limited public routes).
import { sleep } from "k6";
import { Counter } from "k6/metrics";
import { arrive, linkFor } from "./lib.js";

const people = Number(__ENV.OFFICE_PEOPLE || 40);
const minutes = Number(__ENV.OFFICE_MINUTES || 2);
const through = new Counter("office_through");

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    office: { executor: "per-vu-iterations", vus: 1, iterations: 1, maxDuration: `${minutes + 3}m` },
  },
  thresholds: {
    // The product statement: a normal office is not refused.
    legit_throttled: ["count==0"],
    http_5xx: ["count==0"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export default function () {
  const gap = (minutes * 60) / people;
  for (let i = 0; i < people; i += 1) {
    // One campaign link for the whole office: an announcement names one interview.
    if (arrive(`office-${i}`, linkFor(0))) through.add(1);
    sleep(gap * (0.5 + Math.random()));
  }
}

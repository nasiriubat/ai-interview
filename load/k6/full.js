// The full load run (docs/DEPLOY.md, "Capacity and load"): 40 concurrent interviews of 20 turns with
// think time, 5 live-voice sessions, a campaign-launch burst of 100 link opens inside a minute from
// distinct client addresses, and the admin reading dashboards, all at once.
//
//   load/run.sh full
//
// Thresholds are the acceptance numbers: error rate under 1 percent, p95 first token under 2000 ms,
// p95 voice first word under 1500 ms, and no 5xx at all. The fake provider's own latency is part of
// each number, so what the run measures is the platform's overhead on top of a stated provider.
export { participant, launchBurst, adminReads, voiceSession } from "./scenarios.js";

const VUS = Number(__ENV.PARTICIPANTS || 40);
const VOICE = Number(__ENV.VOICE_SESSIONS || 5);
const BURST = Number(__ENV.BURST_OPENS || 100);
const HOLD = __ENV.HOLD || "3m";

// ONLY=burst (or a comma list) runs a subset, for isolating one scenario.
const ONLY = (__ENV.ONLY || "").split(",").filter(Boolean);
const pick = (all) =>
  ONLY.length === 0 ? all : Object.fromEntries(Object.entries(all).filter(([name]) => ONLY.includes(name)));

export const options = {
  insecureSkipTLSVerify: true,
  noConnectionReuse: false,
  scenarios: pick({
    participants: {
      executor: "ramping-vus",
      exec: "participant",
      startVUs: 0,
      stages: [
        { duration: "30s", target: VUS },
        { duration: HOLD, target: VUS },
        { duration: "20s", target: 0 },
      ],
      gracefulRampDown: "90s",
      gracefulStop: "90s",
    },
    voice: {
      executor: "constant-vus",
      exec: "voiceSession",
      vus: VOICE,
      duration: HOLD,
      startTime: "20s",
      gracefulStop: "60s",
    },
    burst: {
      executor: "constant-arrival-rate",
      exec: "launchBurst",
      rate: BURST,
      timeUnit: "1m",
      duration: "1m",
      preAllocatedVUs: Math.min(BURST, 100),
      maxVUs: BURST,
      startTime: "45s",
    },
    admin: {
      executor: "constant-vus",
      exec: "adminReads",
      vus: 2,
      duration: HOLD,
      startTime: "30s",
    },
  }),
  thresholds: {
    "turn_errors": ["rate<0.01"],
    "first_token_ms": ["p(95)<2000"],
    "http_5xx": ["count==0"],
    "link_open_errors": ["rate<0.01"],
    "admin_errors": ["rate<0.01"],
    "voice_first_word_ms": ["p(95)<1500"],
    "voice_session_errors": ["count==0"],
    "http_req_failed{name:turn}": ["rate<0.01"],
    "http_req_failed{name:open}": ["rate<0.01"],
    "http_req_failed{name:admin}": ["rate<0.01"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// The small, fast version of the full run: enough to know that every scenario still works and the
// thresholds still hold, in about two minutes. `pnpm load:smoke` (load/run.sh smoke).
export { participant, launchBurst, adminReads, voiceSession } from "./scenarios.js";

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    participants: {
      executor: "per-vu-iterations",
      exec: "participant",
      vus: 4,
      iterations: 1,
      maxDuration: "3m",
    },
    voice: { executor: "per-vu-iterations", exec: "voiceSession", vus: 1, iterations: 1, maxDuration: "2m" },
    burst: {
      executor: "constant-arrival-rate",
      exec: "launchBurst",
      rate: 12,
      timeUnit: "30s",
      duration: "30s",
      preAllocatedVUs: 12,
      maxVUs: 12,
    },
    admin: { executor: "per-vu-iterations", exec: "adminReads", vus: 1, iterations: 1, maxDuration: "2m" },
  },
  thresholds: {
    "turn_errors": ["rate<0.01"],
    "first_token_ms": ["p(95)<2000"],
    "http_5xx": ["count==0"],
    "link_open_errors": ["rate<0.01"],
    "admin_errors": ["rate<0.01"],
    "voice_first_word_ms": ["p(95)<1500"],
    "voice_session_errors": ["count==0"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

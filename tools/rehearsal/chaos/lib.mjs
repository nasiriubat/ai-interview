// Shared by the chaos scripts (tools/rehearsal/chaos/*.mjs). Each script breaks one thing in the running
// drill stack (tools/rehearsal/drill/stack.sh up) and asserts what docs/OPERATIONS.md says happens: the
// participant is told the truth, the session can be resumed, no job is lost or doubled, and the
// alert reaches the webhook sink.
//
//   tools/rehearsal/drill/stack.sh run node tools/rehearsal/chaos/provider-5xx.mjs
//   tools/rehearsal/chaos/run.sh                       # all of them, in order
//
// A script prints one line per check and exits non-zero if any failed. Results are also written to
// $AIDP_DRILL_DIR/chaos/<name>.json for the drill record.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_EMAIL,
  BASE,
  Client,
  FAKE,
  fakeControl,
  fakeReset,
  log,
  OPERATOR_EMAIL,
  signIn,
  sinkClear,
  sinkReceived,
  sleep,
  staff,
} from "../drill/lib.mjs";

export { BASE, Client, FAKE, fakeControl, fakeReset, log, sinkClear, sinkReceived, sleep, staff, signIn };
export { ADMIN_EMAIL, OPERATOR_EMAIL };

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, "..", "..", "..");
export const DRILL_DIR = process.env.AIDP_DRILL_DIR ?? "";
export const campaign = JSON.parse(readFileSync(join(DRILL_DIR, "campaign.json"), "utf8"));

/** `deploy/dc` with the drill's environment (already exported by `stack.sh run`). */
export function dc(...args) {
  const r = spawnSync(join(REPO, "deploy", "dc"), args, { encoding: "utf8", env: process.env });
  if (r.status !== 0) {
    throw new Error(`dc ${args.join(" ")} -> ${r.status}: ${(r.stderr || r.stdout).slice(-400)}`);
  }
  return r.stdout;
}
export const dcTry = (...args) => {
  try {
    return dc(...args);
  } catch (e) {
    return String(e.message);
  }
};

export function psql(sql, db = "ai_discovery") {
  return dc("exec", "-T", "postgres", "psql", "-U", "app", "-d", db, "-tAX", "-c", sql).trim();
}

export function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

export function containerId(service) {
  return docker(
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${process.env.COMPOSE_PROJECT_NAME ?? "aidpfull"}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ).split("\n")[0];
}

/**
 * Kills a service's main process with SIGKILL from outside its PID namespace, which is what a crash
 * or the OOM killer is to Docker. `docker kill` is not that: Docker counts it as a manual stop and
 * the restart policy does not apply, so the container simply stays down (the first version of
 * kill-worker.mjs found that out). A privileged one-shot in the host PID namespace sends the signal.
 */
export function crash(service) {
  const id = containerId(service);
  const pid = docker("inspect", "-f", "{{.State.Pid}}", id);
  if (!pid || pid === "0") throw new Error(`${service} is not running`);
  docker("run", "--rm", "--privileged", "--pid=host", "alpine:3", "kill", "-9", pid);
  return pid;
}

export function restartCount(service) {
  return Number(docker("inspect", "-f", "{{.RestartCount}}", containerId(service)));
}

export async function waitFor(what, fn, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** API readiness, from inside the network, so it does not depend on Caddy. */
export function apiReady() {
  try {
    const out = dc(
      "exec",
      "-T",
      "api",
      "node",
      "-e",
      "fetch('http://127.0.0.1:4000/api/v1/health/ready').then(async r=>{console.log(r.status, await r.text())},()=>console.log('down'))",
    );
    return out.trim();
  } catch {
    return "unreachable";
  }
}

export async function stackHealthy(timeoutMs = 120_000) {
  await waitFor(
    "every service healthy",
    () => {
      const rows = dc("ps", "--format", "{{.Service}}={{.Health}}={{.State}}")
        .trim()
        .split("\n")
        .map((l) => l.split("="));
      const bad = rows.filter(([svc, health, state]) => {
        if (["migrate", "db-grants", "preflight", "ops-state-init"].includes(svc)) return false;
        return state !== "running" || (health !== "healthy" && health !== "");
      });
      return bad.length === 0;
    },
    { timeoutMs, everyMs: 2000 },
  );
}

/** A participant who has opened the campaign link and consented, with a cookie jar of their own. */
export async function newParticipant(label) {
  const p = new Client(label);
  const arrival = await p.ok("GET", `/api/participant/p/${campaign.linkToken}`);
  await p.ok("POST", `/api/participant/p/${campaign.linkToken}/open`, {});
  await p.ok("POST", "/api/participant/p/session/consent", {
    consentVersion: arrival.campaign.consentVersion ?? "v1",
    participantFields: { name: label },
    participationChoice: "anonymous",
  });
  return p;
}

export const turn = (p, content) =>
  p.turn(
    "/api/participant/p/session/turns",
    content === undefined ? undefined : { content, modality: "text" },
  );

export async function transcript(p) {
  const view = await p.ok("GET", "/api/participant/p/session");
  return view;
}

/** Queues the platform's health sweep now instead of waiting for its five-minute tick. */
export async function runHealthSweep() {
  const before = psql(
    `select count(*) from pgboss.job where name = 'ops.health-sweep' and state = 'completed'`,
  );
  psql(`insert into pgboss.job (name, data) values ('ops.health-sweep', '{}'::jsonb)`);
  await waitFor(
    "the health sweep to complete",
    () =>
      Number(
        psql(`select count(*) from pgboss.job where name = 'ops.health-sweep' and state = 'completed'`),
      ) > Number(before),
    { timeoutMs: 90_000, everyMs: 1000 },
  );
}

/** What the webhook sink has seen whose body or title mentions `kind`. */
export async function alertsLike(kind) {
  return (await sinkReceived()).filter((m) => `${m.title ?? ""} ${m.body}`.includes(kind));
}

// ---------------------------------------------------------------------------------------------

const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  [${detail}]` : ""}`);
  return Boolean(ok);
}

export function note(text) {
  console.log(`  note ${text}`);
  results.push({ name: `note: ${text}`, ok: true, detail: "" });
}

/** Runs a scenario, always restoring the fake and reporting; the process exit code is the verdict. */
export async function scenario(name, body) {
  console.log(`\n=== chaos: ${name}`);
  const started = Date.now();
  let error = null;
  try {
    await body();
  } catch (e) {
    error = e;
    check("the scenario ran to its end", false, e.message);
  } finally {
    try {
      await fakeReset();
    } catch {
      // the fake may be the thing that was broken
    }
  }
  const failed = results.filter((r) => !r.ok);
  const out = join(DRILL_DIR, "chaos");
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, `${name}.json`),
    JSON.stringify(
      { name, at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), results },
      null,
      2,
    ),
  );
  console.log(
    `=== ${name}: ${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s`,
  );
  process.exit(failed.length === 0 && !error ? 0 : 1);
}

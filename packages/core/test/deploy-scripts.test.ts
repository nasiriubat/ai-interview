import { execFile, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALERT_KIND_NAMES,
  ALERT_KINDS,
  runbookAnchor,
  webhookBody,
  type RenderedAlert,
} from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const deploy = join(root, "deploy");
const read = (...p: string[]): string => readFileSync(join(root, ...p), "utf8");

/**
 * The deploy scripts are the part of operations that is not TypeScript, and the part that runs
 * when something has already gone wrong. Their tests are shell harnesses (deploy/test), run here so
 * that `pnpm check` is what runs them: a script nobody runs the tests of is a script nobody trusts.
 *
 * Each harness puts a fake docker, git, curl, age, pg_dump and the rest first on PATH, so this
 * needs bash and jq and nothing else: no Docker, no network.
 */
describe("deploy script harnesses", () => {
  const harnesses = readdirSync(join(deploy, "test"))
    .filter((f) => f.endsWith(".test.sh"))
    .sort();

  it("has the harnesses the operations plan names", () => {
    expect(harnesses).toEqual(
      expect.arrayContaining([
        "backup.test.sh",
        "env.test.sh",
        "notify.test.sh",
        "preflight.test.sh",
        "release.test.sh",
        "restore.test.sh",
      ]),
    );
  });

  it("finds jq, which the scripts and their harnesses read JSON with", () => {
    const r = spawnSync("jq", ["--version"], { encoding: "utf8" });
    expect(r.status, "jq is required to run the deploy harnesses").toBe(0);
  });

  for (const file of harnesses) {
    it(`${file} passes`, async () => {
      // Asynchronous on purpose: a synchronous spawn blocks the test worker's event loop for as
      // long as the harness runs, and the runner reads that as a hung worker.
      const r = await new Promise<{ code: number; out: string }>((done) => {
        execFile(
          "bash",
          [join(deploy, "test", file)],
          {
            cwd: root,
            timeout: 120_000,
            maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, BACKUP_TEST_REAL_AGE: "0" },
          },
          (err, stdout, stderr) => {
            const code = err ? ((err as { code?: number }).code ?? 1) : 0;
            done({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
          },
        );
      });
      // The harness prints which check failed; surface it instead of a bare exit status.
      const failures = r.out
        .split("\n")
        .filter((l) => l.includes("FAIL") || l.includes("missing ["))
        .join("\n");
      expect(r.code, `${file}\n${failures}\n${r.out.split("\n").slice(-6).join("\n")}`).toBe(0);
    }, 150_000);
  }
});

describe("every script is syntactically valid bash", () => {
  const scripts = [
    "backup.sh",
    "backup-health.sh",
    "restore.sh",
    "preflight.sh",
    "generate-env.sh",
    "ensure-backup-key.sh",
    "upgrade.sh",
    "rollback.sh",
    "lib.sh",
    "dc",
    "ops/notify.sh",
  ];
  for (const s of scripts) {
    it(s, () => {
      const r = spawnSync("bash", ["-n", join(deploy, s)], { encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    });
  }
});

describe("shell producers and the alert catalog", () => {
  /** Kinds a script can emit, found by the three ways the scripts name one. */
  function emitted(text: string): string[] {
    const found = new Set<string>();
    for (const m of text.matchAll(/emit_alert\s+([a-z_.]+)/g)) found.add(m[1] ?? "");
    for (const m of text.matchAll(/\braise\s+([a-z_.]+)\s+(?:info|warning|critical)/g)) found.add(m[1] ?? "");
    for (const m of text.matchAll(/"kind":"([a-z_.]+)"/g)) found.add(m[1] ?? "");
    for (const m of text.matchAll(/--arg kind "([a-z_.]+)"/g)) found.add(m[1] ?? "");
    found.delete("");
    return [...found];
  }

  for (const file of ["backup.sh", "preflight.sh", "ops/notify.sh"]) {
    it(`${file} only emits kinds the catalog defines`, () => {
      const kinds = emitted(read("deploy", file));
      expect(kinds.length, `${file} should emit at least one alert`).toBeGreaterThan(0);
      for (const k of kinds) expect(ALERT_KIND_NAMES, `${file} emits ${k}`).toContain(k);
    });
  }

  it("together emit the shell-side alerts the plan lists", () => {
    const all = new Set(
      ["backup.sh", "preflight.sh", "ops/notify.sh"].flatMap((f) => emitted(read("deploy", f))),
    );
    for (const k of [
      "rls.preflight_failed",
      "backup.offsite_failed",
      "backup.failed",
      "backup.missing",
      "disk.high",
      "worker.heartbeat_stale",
      "api.down",
      "tls.renewal",
    ])
      expect([...all], `no shell producer emits ${k}`).toContain(k);
  });

  it("the sidecar's generic webhook body has the fields the TypeScript channel sends", () => {
    const alert: RenderedAlert = {
      kind: "disk.high",
      severity: "critical",
      key: "k",
      title: "t",
      message: "m",
      occurredAt: new Date(0),
      count: 1,
      context: {},
      links: [],
    };
    const ts = Object.keys(
      JSON.parse(webhookBody("generic", "https://x.example/h", alert, "[p]").body) as object,
    )
      .sort()
      .join(",");
    const harness = read("deploy", "test", "notify.test.sh");
    const m = /"(companyId,context,count[a-zA-Z,]*)"/.exec(harness);
    expect(m?.[1]).toBe(ts);
  });

  it("every kind has a repeat window and a severity (a row cannot be added half-way)", () => {
    for (const [kind, spec] of Object.entries(ALERT_KINDS)) {
      expect(spec.repeatMinutes, kind).toBeGreaterThan(0);
      expect(["info", "warning", "critical"], kind).toContain(spec.severity);
      expect(spec.audience.length, kind).toBeGreaterThan(0);
    }
  });
});

describe("docs/OPERATIONS.md", () => {
  const doc = read("docs", "OPERATIONS.md");
  const headings = doc
    .split("\n")
    .filter((l) => l.startsWith("### "))
    .map((l) => l.slice(4).trim());

  it("has a runbook section for every alert kind, under the heading its anchor names", () => {
    for (const kind of ALERT_KIND_NAMES) {
      expect(headings, `no "### ${kind}" section`).toContain(kind);
      // The anchor an alert carries must be what GitHub makes of that heading.
      expect(runbookAnchor(kind)).toBe(kind.toLowerCase().replace(/[^a-z0-9_ -]/g, ""));
    }
  });

  it("has a section for each way an upgrade can fail", () => {
    expect(headings).toContain("migrate.failed");
  });

  it("has the security runbooks, each with the four parts, under the anchors the code points at", () => {
    for (const heading of ["audit.chain_broken", "crypto.rekey"]) {
      expect(headings, `no "### ${heading}" section`).toContain(heading);
      const start = doc.indexOf(`### ${heading}\n`);
      const next = doc.indexOf("\n### ", start + 1);
      const section = doc.slice(start, next === -1 ? undefined : next);
      for (const part of ["**Symptom**", "**Look at**", "**Do**", "**Fixed when**"])
        expect(section, `${heading} is missing ${part}`).toContain(part);
    }
    // The preflight message and the DEPLOY.md link use GitHub's slug of these headings.
    expect(read("deploy", "preflight.sh")).toContain("OPERATIONS.md#auditchain_broken");
    expect(read("docs", "DEPLOY.md")).toContain("OPERATIONS.md#cryptorekey");
  });

  it("gives each runbook section the four parts an operator at 3 a.m. needs", () => {
    for (const kind of ALERT_KIND_NAMES) {
      const start = doc.indexOf(`### ${kind}\n`);
      const next = doc.indexOf("\n### ", start + 1);
      const section = doc.slice(start, next === -1 ? undefined : next);
      for (const part of ["**Symptom**", "**Look at**", "**Do**", "**Fixed when**"])
        expect(section, `${kind} is missing ${part}`).toContain(part);
    }
  });
});

describe("compose.prod.yml", () => {
  const compose = read("deploy", "compose.prod.yml");

  it("pins the project name and tags every built image with the version", () => {
    expect(compose).toMatch(/^name: aidp$/m);
    for (const image of ["aidp-server", "aidp-web", "aidp-backup", "aidp-ops-notify"])
      expect(compose, image).toContain(`${image}:\${AIDP_VERSION`);
    expect(compose).not.toMatch(/aidp-(server|web):latest/);
  });

  it("no longer asks whether PID 1 exists", () => {
    // Mentioned in a comment explaining what it used to be; what must not exist is the check.
    expect(compose).not.toMatch(/test:.*kill -0 1/);
    expect(compose).toContain("/ops-state/heartbeat/worker");
  });

  it("makes the backup healthcheck read the last result, not the loop", () => {
    expect(compose).toContain("/usr/local/bin/backup-health.sh");
    expect(compose).not.toContain("/run/backup-alive");
  });

  it("mounts the shared ops_state volume where it is written and read", () => {
    const blocks = compose.split(/\n {2}(?=[a-z-]+:\n)/);
    for (const svc of ["preflight", "worker", "backup", "ops-notify", "ops-state-init"]) {
      const block = blocks.find((b) => b.startsWith(`${svc}:`)) ?? "";
      expect(block, `${svc} should mount ops_state`).toContain("ops_state:/ops-state");
    }
  });
});

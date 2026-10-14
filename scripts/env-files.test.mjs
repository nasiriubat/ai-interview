// Tests the env-file helpers on temporary files only. Nothing here reads the repository's own .env.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadMerged, mergeEnv, parseEnv } from "./env-files.mjs";

const here = dirname(fileURLToPath(import.meta.url));

describe("parseEnv", () => {
  it("handles comments, quotes, export and empty values", () => {
    const p = parseEnv("# c\nA=1  # note\nexport B=\"x y\"\nC=\nD='q'\n");
    assert.deepEqual(p, { A: "1", B: "x y", C: "", D: "q" });
  });
});

describe("mergeEnv", () => {
  it("adds missing keys, fills empty ones, never overwrites, and reports names", () => {
    const root = "KEEP=root\nEMPTY=   # fill me\n";
    const legacy = "KEEP=legacy\nEMPTY=filled\nNEW=n\nBLANK=\n";
    const r = mergeEnv(root, legacy);
    assert.deepEqual(r.added, ["NEW"]);
    assert.deepEqual(r.filled, ["EMPTY"]);
    assert.deepEqual(r.kept, ["KEEP"]);
    assert.deepEqual(r.conflicts, ["KEEP"]);
    const out = parseEnv(r.text);
    assert.equal(out.KEEP, "root");
    assert.equal(out.EMPTY, "filled");
    assert.equal(out.NEW, "n");
    assert.ok(!("BLANK" in out));
    assert.match(r.text, /EMPTY=filled # fill me/);
  });

  it("is idempotent", () => {
    const first = mergeEnv("A=1\n", "A=2\nB=3\n");
    const second = mergeEnv(first.text, "A=2\nB=3\n");
    assert.deepEqual([second.added, second.filled], [[], []]);
    assert.equal(second.text, first.text);
  });
});

describe("loadMerged", () => {
  it("root wins over legacy and the real environment wins over both", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidp-env-"));
    try {
      writeFileSync(join(dir, "root"), "A=root\nB=root\n");
      writeFileSync(join(dir, "legacy"), "A=legacy\nB=legacy\nC=legacy\n");
      const out = loadMerged({ B: "real" }, join(dir, "root"), join(dir, "legacy"));
      assert.deepEqual(out, { A: "root", C: "legacy" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compose files", () => {
  const read = (f) => readFileSync(join(here, "..", f), "utf8");
  it("development compose reads the root .env last, and production reads no env_file", () => {
    const dev = read("docker-compose.yml");
    assert.match(
      dev,
      /- path: apps\/api\/\.env[^\n]*\n\s+required: false\n\s+- path: \.env\n\s+required: false/,
    );
    assert.ok(!/env_file:\s*apps\/api\/\.env/.test(dev));
    assert.ok(!/^\s*env_file:/m.test(read("deploy/compose.prod.yml")));
  });
});

describe("migrate-env.mjs", () => {
  it("writes the merge, backs up the root file, and prints no value", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidp-env-"));
    try {
      const rootFile = join(dir, ".env");
      writeFileSync(rootFile, "KEEP=rootsecret\nEMPTY=\n");
      writeFileSync(join(dir, "legacy"), "KEEP=legacysecret\nEMPTY=fillsecret\nNEW=newsecret\n");
      const env = { ...process.env, AIDP_ENV_ROOT_FILE: rootFile, AIDP_ENV_LEGACY_FILE: join(dir, "legacy") };
      const out = execFileSync("node", [join(here, "migrate-env.mjs")], { env, encoding: "utf8" });
      assert.match(out, /NEW/);
      assert.match(out, /EMPTY/);
      assert.match(out, /CONFLICT.*KEEP/);
      for (const secret of ["rootsecret", "legacysecret", "fillsecret", "newsecret"])
        assert.ok(!out.includes(secret));
      const merged = parseEnv(readFileSync(rootFile, "utf8"));
      assert.deepEqual(merged, { KEEP: "rootsecret", EMPTY: "fillsecret", NEW: "newsecret" });
      assert.equal(readFileSync(`${rootFile}.bak`, "utf8"), "KEEP=rootsecret\nEMPTY=\n");
      assert.equal(statSync(rootFile).mode & 0o077, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

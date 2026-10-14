// Tests the env-file helpers on temporary files only. Nothing here reads the repository's own .env.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadMerged, mergeEnv, parseEnv, splitLegacySmtp } from "./env-files.mjs";

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

describe("splitLegacySmtp (D-449)", () => {
  const password = "p@ss:w/rd#1 %$x";
  const legacy = `smtp://${encodeURIComponent("relay@x")}:${encodeURIComponent(password)}@smtp.example.com:587`;

  it("splits the URL into SMTP_* with the credentials decoded and quoted so they read back literally", () => {
    const r = splitLegacySmtp(`A=1\nEMAIL_SMTP_URL=${legacy}\nSMTP_HOST=\n`);
    assert.equal(r.status, "split");
    assert.deepEqual(r.keys, ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "SMTP_USER", "SMTP_PASSWORD"]);
    const out = parseEnv(r.text);
    assert.equal(out.SMTP_HOST, "smtp.example.com");
    assert.equal(out.SMTP_PORT, "587");
    assert.equal(out.SMTP_SECURITY, "starttls");
    assert.equal(out.SMTP_USER, "relay@x");
    assert.equal(out.SMTP_PASSWORD, password);
    assert.equal(out.A, "1");
    assert.ok(!("EMAIL_SMTP_URL" in out));
    assert.match(r.text, /SMTP_PASSWORD='p@ss:w\/rd#1 %\$x'/);
  });

  it("maps the security the way the admin form parses it", () => {
    const sec = (u) => parseEnv(splitLegacySmtp(`EMAIL_SMTP_URL=${u}\n`).text);
    assert.deepEqual(
      [sec("smtps://h.example.com").SMTP_SECURITY, sec("smtps://h.example.com").SMTP_PORT],
      ["tls", "465"],
    );
    assert.equal(sec("smtp://mailpit:1025?ignoreTLS=true").SMTP_SECURITY, "none");
    assert.equal(sec("smtp://h.example.com:25").SMTP_SECURITY, "starttls");
  });

  it("leaves the file alone when there is nothing to split, SMTP_HOST is set, or it cannot be done safely", () => {
    assert.equal(splitLegacySmtp("A=1\n").status, "none");
    assert.equal(splitLegacySmtp("EMAIL_SMTP_URL=\n").status, "none");
    assert.equal(splitLegacySmtp(`SMTP_HOST=new\nEMAIL_SMTP_URL=${legacy}\n`).status, "kept");
    assert.equal(splitLegacySmtp("EMAIL_SMTP_URL=https://x\n").status, "invalid");
    const quote = splitLegacySmtp(`EMAIL_SMTP_URL=smtp://u:${encodeURIComponent("it's")}@h.example.com\n`);
    assert.deepEqual([quote.status, quote.keys], ["unquotable", ["SMTP_PASSWORD"]]);
  });

  it("migrate-env --file splits a production file and prints key names only", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidp-env-"));
    try {
      const file = join(dir, "deploy.env");
      writeFileSync(file, `PUBLIC_HOSTNAME=x\nEMAIL_SMTP_URL=${legacy}\n`);
      const out = execFileSync("node", [join(here, "migrate-env.mjs"), "--file", file], { encoding: "utf8" });
      assert.match(out, /EMAIL_SMTP_URL split into/);
      for (const secret of [password, encodeURIComponent(password), "relay@x"])
        assert.ok(!out.includes(secret));
      assert.equal(parseEnv(readFileSync(file, "utf8")).SMTP_PASSWORD, password);
      assert.equal(statSync(file).mode & 0o077, 0);
      assert.equal(statSync(`${file}.bak`).mode & 0o077, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

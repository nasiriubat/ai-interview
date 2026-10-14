import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { destructiveStatements, evaluate, LEGACY_THROUGH, stripNoise } from "./check-migrations.mjs";

const m = (name, sql) => ({ name, sql });

describe("destructive statements", () => {
  it("finds DROP COLUMN and DROP TABLE", () => {
    assert.equal(destructiveStatements('ALTER TABLE "Session" DROP COLUMN "title";').length, 1);
    assert.equal(destructiveStatements('DROP TABLE "Old";').length, 1);
    assert.equal(destructiveStatements('DROP TABLE IF EXISTS "Old";').length, 1);
  });

  it("finds a column added NOT NULL without a default, and a SET NOT NULL", () => {
    assert.equal(destructiveStatements('ALTER TABLE "Fact" ADD COLUMN "language" TEXT NOT NULL;').length, 1);
    assert.equal(destructiveStatements('ALTER TABLE "Fact" ALTER COLUMN "language" SET NOT NULL;').length, 1);
  });

  it("accepts the additive shapes", () => {
    for (const sql of [
      'ALTER TABLE "Fact" ADD COLUMN "language" TEXT;',
      'ALTER TABLE "Session" ADD COLUMN "flagged" BOOLEAN NOT NULL DEFAULT false;',
      'ALTER TABLE "Session" ADD COLUMN "a" TEXT NOT NULL DEFAULT \'x\', ADD COLUMN "b" TEXT;',
      'CREATE TABLE "New" ("id" TEXT NOT NULL, PRIMARY KEY ("id"));',
      'CREATE INDEX "i" ON "Session" ("companyId");',
      'DROP INDEX "i";',
      'ALTER TABLE "Session" DROP CONSTRAINT "fk";',
      'DROP POLICY IF EXISTS "p" ON "Session";',
    ])
      assert.deepEqual(destructiveStatements(sql), [], sql);
  });

  it("reads every clause of a multi-column ALTER", () => {
    const found = destructiveStatements(
      'ALTER TABLE "T" ADD COLUMN "ok" TEXT, ADD COLUMN "bad" TEXT NOT NULL, DROP COLUMN "gone";',
    );
    assert.equal(found.length, 2);
  });

  it("flags renames and type changes, which break the code that still uses the old shape", () => {
    assert.equal(destructiveStatements('ALTER TABLE "T" RENAME COLUMN "a" TO "b";').length, 1);
    assert.equal(destructiveStatements('ALTER TABLE "T" RENAME TO "U";').length, 1);
    assert.equal(destructiveStatements('ALTER TABLE "T" ALTER COLUMN "a" TYPE INTEGER;').length, 1);
  });

  it("ignores what sits in comments and string literals", () => {
    const sql = `-- ALTER TABLE "T" DROP COLUMN "a";
/* DROP TABLE "x"; */
INSERT INTO "Note" ("text") VALUES ('we will DROP COLUMN later; DROP TABLE not now');`;
    assert.deepEqual(destructiveStatements(sql), []);
    assert.ok(!stripNoise(sql).includes("DROP"));
  });
});

describe("migration policy", () => {
  const next = `${String(LEGACY_THROUGH + 1).padStart(4, "0")}_thing`;

  it("passes an additive migration", () => {
    const r = evaluate([m(next, 'ALTER TABLE "Fact" ADD COLUMN "language" TEXT;')]);
    assert.equal(r.ok, true);
  });

  it("fails a new migration that drops a column, and names the migration and the way out", () => {
    const r = evaluate([m(next, 'ALTER TABLE "Session" DROP COLUMN "title";')]);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], new RegExp(next));
    assert.match(r.problems[0], /allow-destructive/);
  });

  it("does not read migrations that predate the policy", () => {
    const old = `${String(LEGACY_THROUGH).padStart(4, "0")}_old`;
    const r = evaluate([m(old, 'ALTER TABLE "Session" DROP COLUMN "title";')]);
    assert.equal(r.ok, true);
  });

  it("accepts an annotated migration and says the release needs the dump", () => {
    const sql = `-- migration-policy: allow-destructive column unused since 0.9; recovery is the pre-migration dump
ALTER TABLE "Session" DROP COLUMN "title";`;
    const r = evaluate([m(next, sql)]);
    assert.equal(r.ok, true);
    assert.match(r.notes[0], /needs the dump/);
  });

  it("refuses an annotation with no reason", () => {
    const r = evaluate([m(next, '-- migration-policy: allow-destructive\nDROP TABLE "Old";')]);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /needs a reason/);
  });

  it("fails two migrations that took the same number", () => {
    const n = String(LEGACY_THROUGH + 1).padStart(4, "0");
    const r = evaluate([m(`${n}_a`, "SELECT 1;"), m(`${n}_b`, "SELECT 1;")]);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /used twice/);
  });

  it("fails a name with no number", () => {
    const r = evaluate([m("thing", "SELECT 1;")]);
    assert.equal(r.ok, false);
  });
});

describe("the repository's own migrations", () => {
  it("pass the gate (the script exits 0)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const out = execFileSync(process.execPath, [join(here, "check-migrations.mjs")], { encoding: "utf8" });
    assert.match(out, /none breaks the policy/);
  });

  it("the CLI exits non-zero on a violation in a directory it is given", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    try {
      const name = `${String(LEGACY_THROUGH + 1).padStart(4, "0")}_bad`;
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "migration.sql"), 'ALTER TABLE "T" DROP COLUMN "a";\n');
      let code = 0;
      try {
        execFileSync(process.execPath, [join(here, "check-migrations.mjs"), resolve(dir)], { stdio: "pipe" });
      } catch (e) {
        code = e.status;
      }
      assert.equal(code, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

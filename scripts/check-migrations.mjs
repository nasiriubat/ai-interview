#!/usr/bin/env node
// Migration policy gate (docs/MIGRATIONS.md, D-178).
//
// Migrations here are forward-fix and additive: a release adds a nullable column, a column with a
// default, a table or an index, and removal ships one release after the code stopped reading the
// old shape. That is what lets the previous code run against the newer schema, which is what makes
// rolling back a tag switch. This gate reads the migrations a release adds and fails on the
// statements that would break that promise:
//
//   - DROP COLUMN, DROP TABLE
//   - RENAME COLUMN, RENAME TO (a rename is a drop for the code that still uses the old name)
//   - ALTER COLUMN ... TYPE
//   - ALTER COLUMN ... SET NOT NULL, ADD COLUMN ... NOT NULL without a DEFAULT
//
// A migration that has a real reason annotates itself, anywhere in the file:
//
//   -- migration-policy: allow-destructive <why, and what the recovery is>
//
// The annotation needs a reason; it covers the whole file and is the sign that the release needs
// the pre-migration dump to roll back (docs/MIGRATIONS.md). Migrations up to and including
// LEGACY_THROUGH predate the policy and are not read.
//
//   node scripts/check-migrations.mjs [migrationsDir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The last migration written before the policy. They are what production already ran. */
export const LEGACY_THROUGH = 17;

const ANNOTATION = /^\s*--\s*migration-policy:\s*allow-destructive\b(.*)$/im;

/** SQL with comments removed and string literals blanked, so a word in either is not read as DDL. */
export function stripNoise(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Splits on `sep` outside parentheses and quotes. */
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * The destructive things one migration's SQL does, as short human descriptions. Pure.
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function destructiveStatements(sql) {
  const found = [];
  for (const statement of splitTopLevel(stripNoise(sql), ";")) {
    const flat = statement.replace(/\s+/g, " ");
    if (/^DROP TABLE\b/i.test(flat)) {
      found.push(`${flat.slice(0, 80)}: drops a table`);
      continue;
    }
    const alter = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?("?[\w.]+"?)\s+([\s\S]*)$/i.exec(flat);
    if (!alter) continue;
    const table = alter[1];
    if (/^RENAME\b/i.test(alter[2] ?? "")) {
      found.push(
        `${table}: ${alter[2]?.slice(0, 60)} (a rename breaks the code that still uses the old name)`,
      );
      continue;
    }
    for (const clause of splitTopLevel(alter[2] ?? "", ",")) {
      if (/^DROP COLUMN\b/i.test(clause)) found.push(`${table}: ${clause.slice(0, 60)}`);
      else if (/^ALTER COLUMN\b.*\bTYPE\b/i.test(clause)) found.push(`${table}: ${clause.slice(0, 60)}`);
      else if (/^ALTER COLUMN\b.*\bSET NOT NULL\b/i.test(clause))
        found.push(`${table}: ${clause.slice(0, 60)} (existing rows and the previous release may hold NULL)`);
      else if (/^ADD COLUMN\b/i.test(clause) && /\bNOT NULL\b/i.test(clause) && !/\bDEFAULT\b/i.test(clause))
        found.push(`${table}: ${clause.slice(0, 60)} (NOT NULL without a DEFAULT fails on existing rows)`);
    }
  }
  return found;
}

/**
 * Decides what the gate says about a set of migrations. Pure; exported for the tests next to it.
 *
 * @param {{ name: string; sql: string }[]} migrations
 * @param {{ legacyThrough?: number }} [options]
 * @returns {{ ok: boolean; problems: string[]; notes: string[] }}
 */
export function evaluate(migrations, options = {}) {
  const legacyThrough = options.legacyThrough ?? LEGACY_THROUGH;
  const problems = [];
  const notes = [];

  // Two branches that each took the next number produce two migrations that sort by name and run
  // in an order nobody chose. Refuse the collision at the gate rather than at deploy.
  const byNumber = new Map();
  for (const m of migrations) {
    const number = /^(\d+)_/.exec(m.name)?.[1];
    if (number === undefined) {
      problems.push(`${m.name}: the name must start with a number and an underscore (0021_what_it_does)`);
      continue;
    }
    byNumber.set(number, [...(byNumber.get(number) ?? []), m.name]);
  }
  for (const [number, names] of byNumber)
    if (names.length > 1) problems.push(`migration number ${number} is used twice: ${names.join(", ")}`);

  for (const m of migrations) {
    const number = Number(/^(\d+)_/.exec(m.name)?.[1] ?? "0");
    if (number <= legacyThrough) continue;
    const bad = destructiveStatements(m.sql);
    if (bad.length === 0) continue;
    const annotation = ANNOTATION.exec(m.sql);
    if (annotation) {
      const reason = (annotation[1] ?? "").trim();
      if (reason.length < 10)
        problems.push(
          `${m.name}: the allow-destructive annotation needs a reason that says why and what the recovery is`,
        );
      else
        notes.push(
          `${m.name}: destructive by annotation (${reason}); this release needs the dump to roll back`,
        );
      continue;
    }
    for (const b of bad)
      problems.push(
        `${m.name}: ${b}. Add it as a nullable column or one with a DEFAULT and remove the old shape a release later, or annotate the file with "-- migration-policy: allow-destructive <why and the recovery>" (docs/MIGRATIONS.md)`,
      );
  }
  return { ok: problems.length === 0, problems, notes };
}

/** Reads `<dir>/<name>/migration.sql` for every migration directory, in name order. */
export function readMigrations(dir) {
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name, "migration.sql"), "utf8") }));
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? resolve(here, "../packages/db/prisma/migrations");
  const result = evaluate(readMigrations(dir));
  for (const note of result.notes) console.log(`note: ${note}`);
  if (!result.ok) {
    for (const p of result.problems) console.error(`migration policy: ${p}`);
    process.exit(1);
  }
  console.log(`migration policy: ${readMigrations(dir).length} migrations checked, none breaks the policy`);
}

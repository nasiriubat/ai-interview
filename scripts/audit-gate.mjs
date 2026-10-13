#!/usr/bin/env node
// Dependency-advisory gate for CI (spec 11, security plan S5b, D-85).
//
// `pnpm audit --prod --audit-level=high` already fails on a high or critical advisory. This wraps
// it for the one situation it cannot express: an advisory with no fix yet, which has to be
// carried knowingly and not forever. An entry in `audit-ignore.json` needs a reason, an owner and
// an expiry date; when the date passes the gate fails again, so an exception cannot be forgotten.
//
//   node scripts/audit-gate.mjs            runs `pnpm audit --prod --json` itself
//   node scripts/audit-gate.mjs report.json   reads a saved report (tests, debugging)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BLOCKING = new Set(["high", "critical"]);

/**
 * Pure: decides what the gate says about a report. Exported for the tests next to it.
 *
 * @param {{ advisories?: Record<string, { github_advisory_id?: string; severity: string; module_name: string; url?: string; title?: string }> }} report
 * @param {{ ignore?: { id: string; reason?: string; owner?: string; expires?: string }[] }} ignoreFile
 * @param {Date} now
 */
export function evaluate(report, ignoreFile, now) {
  const problems = [];
  const notes = [];
  const entries = ignoreFile.ignore ?? [];

  const byId = new Map();
  for (const entry of entries) {
    const missing = ["id", "reason", "owner", "expires"].filter((k) => !entry[k]);
    if (missing.length > 0) {
      problems.push(`audit-ignore.json: entry ${entry.id ?? "(no id)"} is missing ${missing.join(", ")}`);
      continue;
    }
    const expires = new Date(`${entry.expires}T23:59:59Z`);
    if (Number.isNaN(expires.getTime())) {
      problems.push(`audit-ignore.json: ${entry.id} has an expiry that is not a date: ${entry.expires}`);
      continue;
    }
    if (expires < now) {
      problems.push(`audit-ignore.json: ${entry.id} expired on ${entry.expires} (${entry.reason})`);
      continue;
    }
    byId.set(entry.id, entry);
  }

  const seen = new Set();
  for (const advisory of Object.values(report.advisories ?? {})) {
    const id = advisory.github_advisory_id ?? "";
    seen.add(id);
    if (!BLOCKING.has(advisory.severity)) continue;
    if (byId.has(id)) {
      notes.push(
        `ignored until ${byId.get(id).expires}: ${id} ${advisory.module_name} (${advisory.severity})`,
      );
      continue;
    }
    problems.push(
      `${advisory.severity}: ${advisory.module_name} ${id} ${advisory.title ?? ""} ${advisory.url ?? ""}`.trim(),
    );
  }
  for (const id of byId.keys()) {
    if (!seen.has(id)) notes.push(`audit-ignore.json: ${id} no longer matches an advisory; remove it`);
  }
  return { ok: problems.length === 0, problems, notes };
}

function loadReport(path) {
  if (path) return JSON.parse(readFileSync(path, "utf8"));
  let out;
  try {
    out = execFileSync("pnpm", ["audit", "--prod", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // pnpm exits non-zero when it finds anything; the report is still on stdout.
    out = err.stdout?.toString() ?? "";
    if (!out) throw err;
  }
  return JSON.parse(out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ignoreFile = JSON.parse(readFileSync(new URL("../audit-ignore.json", import.meta.url), "utf8"));
  const result = evaluate(loadReport(process.argv[2]), ignoreFile, new Date());
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const problem of result.problems) console.error(`FAIL: ${problem}`);
  if (!result.ok) process.exit(1);
  console.log("audit gate: no unignored high or critical advisories in production dependencies");
}

#!/usr/bin/env node
// Small repository gates for the security programme (Security M3, D-267, D-268). Three checks, each
// a pure function the tests exercise, run by `pnpm check` and by the `security` workflow:
//
//   node scripts/security-gates.mjs trivy         .github/security/.trivyignore.yaml: justified, expiring entries only
//   node scripts/security-gates.mjs workflows     every GitHub Action is pinned by commit SHA
//   node scripts/security-gates.mjs security-txt  security.txt is present, and has not expired
//
// They are plain Node on purpose: they have to run before dependencies are installed.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The longest an exception may be carried at once; a longer one is a decision, not an exception. */
export const MAX_IGNORE_DAYS = 180;
const DAY_MS = 86_400_000;

/**
 * `.github/security/.trivyignore.yaml` is a Trivy ignore file. Every entry names why it is carried (`statement`)
 * and when it stops being (`expired_at`), and the expiry is at most {@link MAX_IGNORE_DAYS} from
 * today: an exception that needs a longer life is renewed on purpose, with the reason re-read.
 * The file is JSON, which is valid YAML, so this needs no parser and Trivy reads it unchanged.
 *
 * @param {{ [list: string]: { id?: string; statement?: string; expired_at?: string }[] }} file
 * @param {Date} now
 */
export function evaluateTrivyIgnore(file, now) {
  const problems = [];
  const notes = [];
  for (const [list, entries] of Object.entries(file)) {
    if (!Array.isArray(entries)) {
      problems.push(`.github/security/.trivyignore.yaml: ${list} is not a list`);
      continue;
    }
    for (const entry of entries) {
      const label = `${list}: ${entry.id ?? "(no id)"}`;
      if (!entry.id) problems.push(`.github/security/.trivyignore.yaml: ${label} has no id`);
      if (!entry.statement || entry.statement.trim().length < 20)
        problems.push(
          `.github/security/.trivyignore.yaml: ${label} needs a statement that says why it is carried`,
        );
      const expires = entry.expired_at ? new Date(`${entry.expired_at}T23:59:59Z`) : null;
      if (!expires || Number.isNaN(expires.getTime())) {
        problems.push(`.github/security/.trivyignore.yaml: ${label} needs expired_at (YYYY-MM-DD)`);
        continue;
      }
      if (expires < now)
        problems.push(`.github/security/.trivyignore.yaml: ${label} expired on ${entry.expired_at}`);
      else if (expires.getTime() - now.getTime() > MAX_IGNORE_DAYS * DAY_MS)
        problems.push(
          `.github/security/.trivyignore.yaml: ${label} expires more than ${String(MAX_IGNORE_DAYS)} days from now (${entry.expired_at})`,
        );
      else notes.push(`${label} carried until ${entry.expired_at}`);
    }
  }
  return { ok: problems.length === 0, problems, notes };
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Every `uses:` of a third-party action must name a full commit SHA: a tag is a pointer its owner
 * can move, and a compromised action runs with the repository's token. A trailing `# vX.Y.Z`
 * comment keeps it readable and is what Dependabot updates. Local actions (`./`) and `docker://`
 * images pinned by digest are fine.
 *
 * @param {string} text workflow file contents
 * @returns {string[]} one message per unpinned use
 */
export function unpinnedUses(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    const m = /^\s*-?\s*uses:\s*([^\s#]+)/.exec(line);
    if (!m) return;
    const ref = m[1].replace(/^['"]|['"]$/g, "");
    if (ref.startsWith("./")) return;
    if (ref.startsWith("docker://")) {
      if (!/@sha256:[0-9a-f]{64}$/.test(ref))
        out.push(`line ${String(i + 1)}: ${ref} is not pinned by digest`);
      return;
    }
    const at = ref.lastIndexOf("@");
    const version = at === -1 ? "" : ref.slice(at + 1);
    if (!FULL_SHA.test(version)) out.push(`line ${String(i + 1)}: ${ref} is not pinned by commit SHA`);
  });
  return out;
}

/**
 * RFC 9116: `Contact` and `Expires` are required. The file must not be expired and must not
 * promise more than a year (a stale policy is worse than none: it says nobody is reading).
 * A contact that still carries the owner's placeholder is a note, not a failure, so the repository
 * builds before the owner has chosen an address, and the note is printed on every run.
 *
 * @param {string} text
 * @param {Date} now
 */
export function evaluateSecurityTxt(text, now) {
  const problems = [];
  const notes = [];
  const fields = new Map();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (m) fields.set(m[1].toLowerCase(), [...(fields.get(m[1].toLowerCase()) ?? []), m[2]]);
  }
  const contacts = fields.get("contact") ?? [];
  if (contacts.length === 0) problems.push("security.txt: no Contact field");
  if (contacts.some((c) => c.includes("<your-domain>")))
    notes.push("security.txt: the Contact is still the placeholder; the owner must set a real address");
  const expiresRaw = fields.get("expires")?.[0];
  if (!expiresRaw) {
    problems.push("security.txt: no Expires field");
  } else {
    const expires = new Date(expiresRaw);
    if (Number.isNaN(expires.getTime())) problems.push(`security.txt: Expires is not a date: ${expiresRaw}`);
    else if (expires < now) problems.push(`security.txt: expired on ${expiresRaw}`);
    else if (expires.getTime() - now.getTime() > 366 * DAY_MS)
      problems.push(`security.txt: Expires is more than a year away (${expiresRaw})`);
    else if (expires.getTime() - now.getTime() < 30 * DAY_MS)
      notes.push(`security.txt: expires within 30 days (${expiresRaw}); renew it`);
  }
  return { ok: problems.length === 0, problems, notes };
}

function report(result, okMessage) {
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const problem of result.problems) console.error(`FAIL: ${problem}`);
  if (!result.ok) process.exit(1);
  console.log(okMessage);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const which = process.argv[2];
  if (which === "trivy") {
    const file = JSON.parse(readFileSync(path.join(ROOT, ".github/security/.trivyignore.yaml"), "utf8"));
    report(
      evaluateTrivyIgnore(file, new Date()),
      "trivy ignore file: every entry is justified and unexpired",
    );
  } else if (which === "workflows") {
    const dir = path.join(ROOT, ".github", "workflows");
    const problems = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .flatMap((f) => unpinnedUses(readFileSync(path.join(dir, f), "utf8")).map((p) => `${f}: ${p}`));
    report(
      { ok: problems.length === 0, problems, notes: [] },
      "workflows: every action is pinned by commit SHA",
    );
  } else if (which === "security-txt") {
    const text = readFileSync(
      path.join(ROOT, "apps", "web", "public", ".well-known", "security.txt"),
      "utf8",
    );
    report(evaluateSecurityTxt(text, new Date()), "security.txt: present and unexpired");
  } else {
    console.error("usage: security-gates.mjs trivy | workflows | security-txt");
    process.exit(2);
  }
}

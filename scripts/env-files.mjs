// Shared by with-env.mjs, migrate-env.mjs and stack-up.mjs. Reads dotenv files and never prints a
// value: everything this module returns for display is a key name or a count.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT_ENV = join(REPO_ROOT, ".env");
/** Where the API's configuration lived before there was one root file. */
export const LEGACY_ENV = join(REPO_ROOT, "apps/api/.env");

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** The text after `=` exactly as written, minus an unquoted trailing ` # comment`. */
export function rawValue(rest) {
  const t = rest.trim();
  if (t.startsWith('"') || t.startsWith("'")) return t;
  if (t.startsWith("#")) return "";
  const hash = t.search(/\s#/);
  return (hash === -1 ? t : t.slice(0, hash)).trim();
}

function unquote(raw) {
  if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.at(-1) === raw[0]) return raw.slice(1, -1);
  return raw;
}

/** KEY -> parsed value, for a dotenv file's text. Later lines win. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out[m[1]] = unquote(rawValue(m[2]));
  }
  return out;
}

export function readEnvFile(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
}

/**
 * Root `.env` over the legacy `apps/api/.env`, over nothing else. A value already in the real
 * environment is never replaced (that is how CI and `KEY=x pnpm ...` keep working).
 */
export function loadMerged(env = process.env, root = ROOT_ENV, legacy = LEGACY_ENV) {
  const merged = { ...readEnvFile(legacy) };
  // An empty root value (`KEY=`) does not hide a legacy one: it is "not set yet".
  for (const [k, v] of Object.entries(readEnvFile(root))) if (v !== "" || !merged[k]) merged[k] = v;
  const out = {};
  for (const [k, v] of Object.entries(merged)) if (env[k] === undefined) out[k] = v;
  return out;
}

/**
 * Plans the move of `legacyText` into `rootText`. Never overwrites a non-empty root value; an
 * empty root value (`KEY=`) counts as unset and is filled. Returns key names only, plus the new
 * file text (which does contain values: the caller writes it and must not print it).
 */
export function mergeEnv(rootText, legacyText) {
  const root = parseEnv(rootText);
  const legacy = parseEnv(legacyText);
  const legacyRaw = {};
  for (const line of legacyText.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) legacyRaw[m[1]] = rawValue(m[2]);
  }
  const added = [];
  const filled = [];
  const kept = [];
  const conflicts = [];
  const lines = rootText.split(/\r?\n/);
  for (const key of Object.keys(legacy)) {
    const inRoot = Object.prototype.hasOwnProperty.call(root, key);
    if (inRoot && root[key] !== "") {
      kept.push(key);
      if (root[key] !== legacy[key] && legacy[key] !== "") conflicts.push(key);
      continue;
    }
    if (legacy[key] === "") continue; // nothing to bring over
    if (inRoot) {
      // Replace the empty line in place, keeping a trailing comment.
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = LINE.exec(lines[i]);
        if (m && m[1] === key) {
          const comment = /(?:^|\s)#.*$/.exec(m[2].trim());
          lines[i] = `${key}=${legacyRaw[key]}${comment ? ` ${comment[0].trim()}` : ""}`;
          break;
        }
      }
      filled.push(key);
    } else {
      added.push(key);
    }
  }
  let text = lines.join("\n");
  if (added.length) {
    if (text.length && !text.endsWith("\n")) text += "\n";
    text += `\n# Moved from apps/api/.env by scripts/migrate-env.mjs\n`;
    for (const key of added) text += `${key}=${legacyRaw[key]}\n`;
  }
  return { text, added, filled, kept, conflicts };
}

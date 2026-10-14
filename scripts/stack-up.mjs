#!/usr/bin/env node
// `pnpm stack:up`: checks the env files, then builds and starts the development stack.
// Compose reads the legacy apps/api/.env (if present) first and the root .env over it, so an
// install that has not migrated keeps its values; this only warns, and never prints a value.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { LEGACY_ENV, readEnvFile, ROOT_ENV } from "./env-files.mjs";

const root = readEnvFile(ROOT_ENV);
const legacy = readEnvFile(LEGACY_ENV);
const hasLegacy = existsSync(LEGACY_ENV);
if (!existsSync(ROOT_ENV) && !hasLegacy) {
  console.error(
    "No .env found. Run: cp .env.example .env   then fill PLATFORM_ENCRYPTION_KEY and AUTH_SECRET.",
  );
  process.exit(1);
}
if (hasLegacy) {
  // Compose lets a later env_file win even when its value is empty, so `KEY=` in .env would
  // silently blank a value that only apps/api/.env sets. Refuse rather than start that way.
  const shadowed = Object.keys(legacy).filter(
    (k) => legacy[k] !== "" && Object.prototype.hasOwnProperty.call(root, k) && root[k] === "",
  );
  const fills = Object.keys(legacy).filter((k) => legacy[k] !== "" && !(k in root));
  const differs = Object.keys(legacy).filter(
    (k) => legacy[k] !== "" && (root[k] ?? "") !== "" && root[k] !== legacy[k],
  );
  console.warn("WARNING: apps/api/.env is legacy. The root .env is the one place for configuration now.");
  console.warn("  It is still read underneath the root file (root wins). Move it with: pnpm env:migrate");
  if (fills.length) console.warn(`  Only in apps/api/.env (still used until migrated): ${fills.join(", ")}`);
  if (differs.length) console.warn(`  Set differently in .env, which wins: ${differs.join(", ")}`);
  if (shadowed.length) {
    console.error(
      `ERROR: empty in .env but set in apps/api/.env, so the empty value would win: ${shadowed.join(", ")}`,
    );
    console.error("  Run `pnpm env:migrate` (it fills them from the legacy file), or set them in .env.");
    process.exit(1);
  }
}
const merged = { ...legacy, ...root };
for (const k of ["PLATFORM_ENCRYPTION_KEY", "AUTH_SECRET"]) {
  if (!(merged[k] ?? "").trim())
    console.warn(`WARNING: ${k} is empty (openssl rand -base64 32); the stack will not work without it.`);
}
// The relay (D-445). The compose stack points every service at Mailpit itself, so this is only
// about the names: the one-URL form still works but is deprecated (D-446).
const set = (k) => (merged[k] ?? "").trim() !== "";
if (set("EMAIL_SMTP_URL") || set("EMAIL_SERVER")) {
  const which = ["EMAIL_SMTP_URL", "EMAIL_SERVER"].filter(set).join(" and ");
  console.warn(
    set("SMTP_HOST")
      ? `WARNING: ${which} is ignored because SMTP_HOST is set; remove it from .env.`
      : `WARNING: ${which} is deprecated; use SMTP_HOST, SMTP_PORT, SMTP_SECURITY, SMTP_USER, SMTP_PASSWORD. pnpm env:migrate splits EMAIL_SMTP_URL for you.`,
  );
}
const run = (args) => spawnSync("docker", args, { stdio: "inherit" }).status ?? 1;
const up = run(["compose", "up", "-d", "--build", "--remove-orphans"]);
if (up !== 0) process.exit(up);
run(["image", "prune", "-f", "--filter", "label=com.docker.compose.project=ai-interview"]);

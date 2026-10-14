#!/usr/bin/env node
// Moves apps/api/.env into the root .env without printing a value.
//
//   pnpm env:migrate            # merge, keep a .env.bak of the root file, report key names
//   pnpm env:migrate --dry-run  # report only
//
// A key already set in the root file is never overwritten. An empty root value (`KEY=`) is filled.
// Where both files set different values the root one is kept and the key is listed as a conflict,
// because the root file is what everything reads from now on. apps/api/.env is left in place:
// delete it yourself once the report looks right.
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { LEGACY_ENV, mergeEnv, ROOT_ENV } from "./env-files.mjs";

const dry = process.argv.includes("--dry-run");
const rootFile = process.env.AIDP_ENV_ROOT_FILE ?? ROOT_ENV;
const legacyFile = process.env.AIDP_ENV_LEGACY_FILE ?? LEGACY_ENV;

if (!existsSync(legacyFile)) {
  console.log("Nothing to migrate: apps/api/.env does not exist.");
  process.exit(0);
}
const rootText = existsSync(rootFile) ? readFileSync(rootFile, "utf8") : "";
const r = mergeEnv(rootText, readFileSync(legacyFile, "utf8"));
const list = (label, keys) => console.log(`${label} (${keys.length}): ${keys.join(", ") || "-"}`);
list("added to .env", r.added);
list("filled (were empty in .env)", r.filled);
list("kept (already set in .env)", r.kept);
if (r.conflicts.length) {
  list("CONFLICT: both files set a different value, .env kept", r.conflicts);
  console.log(
    "  If the running stack used apps/api/.env for these, review them before the next `pnpm stack:up`.",
  );
}
if (dry) {
  console.log("dry run: nothing written.");
  process.exit(0);
}
if (r.added.length + r.filled.length === 0) {
  console.log("The root .env already has everything; nothing written.");
  process.exit(0);
}
if (existsSync(rootFile)) {
  copyFileSync(rootFile, `${rootFile}.bak`);
  chmodSync(`${rootFile}.bak`, 0o600);
}
writeFileSync(rootFile, r.text, { mode: 0o600 });
chmodSync(rootFile, 0o600); // the mode above only applies when the file is created
console.log(
  "written. apps/api/.env is still there and is ignored once .env has the keys; remove it when satisfied.",
);

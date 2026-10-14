#!/usr/bin/env node
// Moves apps/api/.env into the root .env, and splits a legacy EMAIL_SMTP_URL into the SMTP_*
// variables, without printing a value.
//
//   pnpm env:migrate                      # merge, split, keep a .env.bak, report key names
//   pnpm env:migrate --dry-run            # report only
//   pnpm env:migrate --file deploy/.env   # only the EMAIL_SMTP_URL split, on that file
//
// A key already set in the root file is never overwritten. An empty root value (`KEY=`) is filled.
// Where both files set different values the root one is kept and the key is listed as a conflict,
// because the root file is what everything reads from now on. apps/api/.env is left in place:
// delete it yourself once the report looks right.
//
// The relay split (D-449): when EMAIL_SMTP_URL is set and SMTP_HOST is not, the URL is taken apart
// (credentials decoded) into SMTP_HOST, SMTP_PORT, SMTP_SECURITY, SMTP_USER and SMTP_PASSWORD, and
// the URL line is replaced by a note. When SMTP_HOST is already set the URL is ignored at runtime
// and left alone.
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LEGACY_ENV, mergeEnv, ROOT_ENV, splitLegacySmtp } from "./env-files.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const fileAt = args.indexOf("--file");
const only = fileAt === -1 ? undefined : args[fileAt + 1];
if (fileAt !== -1 && !only) {
  console.error("--file needs a path, e.g. --file deploy/.env");
  process.exit(2);
}
const rootFile = only ? resolve(only) : (process.env.AIDP_ENV_ROOT_FILE ?? ROOT_ENV);
const legacyFile = process.env.AIDP_ENV_LEGACY_FILE ?? LEGACY_ENV;
const list = (label, keys) => console.log(`${label} (${keys.length}): ${keys.join(", ") || "-"}`);

if (only && !existsSync(rootFile)) {
  console.error(`${only} does not exist.`);
  process.exit(1);
}
const original = existsSync(rootFile) ? readFileSync(rootFile, "utf8") : "";
let text = original;

if (!only) {
  if (!existsSync(legacyFile)) {
    console.log("Nothing to merge: apps/api/.env does not exist.");
  } else {
    const r = mergeEnv(text, readFileSync(legacyFile, "utf8"));
    list("added to .env", r.added);
    list("filled (were empty in .env)", r.filled);
    list("kept (already set in .env)", r.kept);
    if (r.conflicts.length) {
      list("CONFLICT: both files set a different value, .env kept", r.conflicts);
      console.log(
        "  If the running stack used apps/api/.env for these, review them before the next `pnpm stack:up`.",
      );
    }
    text = r.text;
  }
}

const split = splitLegacySmtp(text);
switch (split.status) {
  case "split":
    list("EMAIL_SMTP_URL split into", split.keys);
    text = split.text;
    break;
  case "kept":
    console.log("EMAIL_SMTP_URL is ignored because SMTP_HOST is set; remove EMAIL_SMTP_URL when convenient.");
    break;
  case "invalid":
    console.log(
      "EMAIL_SMTP_URL is not an smtp:// or smtps:// URL; not split. Set SMTP_HOST and the rest by hand.",
    );
    break;
  case "unquotable":
    console.log(
      `EMAIL_SMTP_URL not split: ${split.keys.join(", ")} would hold a quote or line break. Set the SMTP_* lines by hand.`,
    );
    break;
  default:
    break;
}

if (dry) {
  console.log("dry run: nothing written.");
  process.exit(0);
}
if (text === original) {
  console.log(`${only ?? "The root .env"} already has everything; nothing written.`);
  process.exit(0);
}
if (existsSync(rootFile)) {
  copyFileSync(rootFile, `${rootFile}.bak`);
  chmodSync(`${rootFile}.bak`, 0o600);
}
writeFileSync(rootFile, text, { mode: 0o600 });
chmodSync(rootFile, 0o600); // the mode above only applies when the file is created
console.log(
  only
    ? `written. The previous ${only} is in ${only}.bak (it holds the old URL with the password; delete it when satisfied).`
    : "written. apps/api/.env is still there and is ignored once .env has the keys; remove it when satisfied.",
);

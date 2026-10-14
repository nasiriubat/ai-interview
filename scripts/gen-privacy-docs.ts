/**
 * `pnpm docs:privacy`: writes docs/SUBPROCESSORS.md and docs/PRIVACY-PROCESSING.md from the
 * registry in packages/shared (D-166). `--check` exits 1 when a file differs, which is what the
 * test and CI use, so the documents cannot drift from the code.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { renderProcessingRecord, renderSubprocessors } from "../packages/shared/src/subprocessors.js";

const files: [string, string][] = [
  ["docs/SUBPROCESSORS.md", renderSubprocessors()],
  ["docs/PRIVACY-PROCESSING.md", renderProcessingRecord()],
];
const check = process.argv.includes("--check");
let stale = false;
for (const [path, content] of files) {
  const url = new URL(`../${path}`, import.meta.url);
  if (check) {
    let current = "";
    try {
      current = readFileSync(url, "utf8");
    } catch {
      current = "";
    }
    if (current !== content) {
      console.error(`${path} is out of date; run pnpm docs:privacy`);
      stale = true;
    }
  } else {
    writeFileSync(url, content);
    console.log(`wrote ${path}`);
  }
}
process.exit(stale ? 1 : 0);

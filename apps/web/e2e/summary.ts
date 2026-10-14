import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/** After the run: what axe found, by rule and impact, including what did not fail the run. */
export default function summary(): void {
  const file = path.join(import.meta.dirname, "results", "findings.jsonl");
  if (!existsSync(file)) {
    process.stdout.write("\naxe: no violations of any impact.\n");
    return;
  }
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { rule: string; impact: string | null; page: string; project: string });
  const byRule = new Map<string, { impact: string; pages: Set<string> }>();
  for (const r of rows) {
    const e = byRule.get(r.rule) ?? { impact: r.impact ?? "?", pages: new Set<string>() };
    e.pages.add(r.page);
    byRule.set(r.rule, e);
  }
  process.stdout.write("\naxe findings by rule:\n");
  for (const [rule, e] of [...byRule].sort()) {
    process.stdout.write(`  ${e.impact.padEnd(9)} ${rule}: ${[...e.pages].join(", ")}\n`);
  }
  rmSync(file);
}

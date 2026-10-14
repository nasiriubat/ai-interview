import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureSchema, type Fixture } from "./fixture.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
export const BASELINE_FILE = join(dirname(fileURLToPath(import.meta.url)), "../baselines/replay.json");

/** Every replay fixture under evals/fixtures/<templateKey>/<persona>.json, parsed (a bad file fails the run). */
export function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const dir of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(FIXTURES, dir.name)).sort()) {
      if (!file.endsWith(".json")) continue;
      const raw: unknown = JSON.parse(readFileSync(join(FIXTURES, dir.name, file), "utf8"));
      out.push(FixtureSchema.parse(raw));
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

import { describe, it } from "vitest";
import { loadFixtures } from "./fixtures.js";
import { replayFixture } from "./replay.js";

/**
 * A debugging aid for authoring fixtures and reading a gate failure. A no-op unless
 * EVAL_INSPECT names a fixture id (or `all`):
 *
 *   EVAL_INSPECT=requirements_discovery/terse pnpm --filter @aidp/evals exec vitest run src/inspect.eval.ts
 */
describe("inspect", () => {
  it("prints what a replay recorded", async () => {
    const id = process.env.EVAL_INSPECT;
    if (!id) return;
    for (const f of loadFixtures().filter((x) => id === "all" || x.id === id)) {
      const o = await replayFixture(f);
      console.log(`\n== ${f.id}: ${o.turnsUsed} turns, ended=${String(o.ended)}`);
      console.log(JSON.stringify(o.metrics));
      if (id !== "all") {
        console.log(JSON.stringify(o.detail, null, 1));
        for (const x of o.state.facts)
          if (x.kind === "spec_field")
            console.log(`${x.section}/${x.path}: ${JSON.stringify(x.value).slice(0, 110)}`);
      }
    }
  });
});

import { JOBS, type JobName } from "@aidp/core";
import { describe, expect, it } from "vitest";
import { handlers, type HandlerDeps } from "../src/handlers.js";

/**
 * A job with no consumer is the quietest failure this system can produce.
 *
 * Phase 4 shipped `attachment.ingest` with a payload schema, a publisher, a queue and a handler.
 * TypeScript was satisfied, the job was enqueued, and nothing ever ran it: uploads sat at
 * `pending` forever, with no error in any log. The cause was that `main.ts` listed its consumers
 * by hand, so adding a job registered nothing.
 *
 * `main.ts` now derives the consumers from the handler map. These assert the two halves of that
 * chain — every declared job has a handler, and every handler corresponds to a declared job — so
 * the same gap cannot reopen from either end.
 */
describe("job consumers", () => {
  // Nothing here is called; only the shape of the returned map is inspected.
  const deps = {} as unknown as HandlerDeps;

  it("implements a handler for every job that can be published", () => {
    const declared = Object.keys(JOBS).sort();
    const implemented = Object.keys(handlers(deps)).sort();

    expect(implemented).toEqual(declared);
  });

  it("has no handler for a job that cannot be published", () => {
    // The reverse direction: a handler whose job was renamed or removed would never be consumed
    // either, because the queue it waits on does not exist.
    for (const name of Object.keys(handlers(deps))) {
      expect(JOBS).toHaveProperty(name);
    }
  });

  it("gives every handler a callable function", () => {
    const h = handlers(deps);
    for (const name of Object.keys(JOBS) as JobName[]) {
      expect(typeof h[name]).toBe("function");
    }
  });
});

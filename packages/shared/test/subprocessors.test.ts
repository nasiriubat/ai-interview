import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROVIDER_KINDS } from "../src/providers.js";
import { PROVIDER_SUBPROCESSORS, renderProcessingRecord, renderSubprocessors } from "../src/subprocessors.js";

const doc = (name: string): string => readFileSync(new URL(`../../../docs/${name}`, import.meta.url), "utf8");

/** The GDPR package is generated from the code (D-166), so it cannot say something the code does not. */
describe("sub-processor registry and the generated privacy documents", () => {
  it("has an entry, with data and a transfer statement, for every provider kind", () => {
    for (const kind of PROVIDER_KINDS) {
      const entry = PROVIDER_SUBPROCESSORS[kind] as (typeof PROVIDER_SUBPROCESSORS)[typeof kind] | undefined;
      expect(entry, `no sub-processor entry for provider kind '${kind}'`).toBeDefined();
      expect(entry?.data.length, kind).toBeGreaterThan(0);
      expect(entry?.transfer.length, kind).toBeGreaterThan(0);
    }
    expect(Object.keys(PROVIDER_SUBPROCESSORS).sort()).toEqual([...PROVIDER_KINDS].sort());
  });

  it("keeps docs/SUBPROCESSORS.md and docs/PRIVACY-PROCESSING.md equal to the registry (run pnpm docs:privacy)", () => {
    expect(doc("SUBPROCESSORS.md")).toBe(renderSubprocessors());
    expect(doc("PRIVACY-PROCESSING.md")).toBe(renderProcessingRecord());
  });

  it("names every provider kind in the sub-processor list", () => {
    const text = renderSubprocessors();
    for (const kind of PROVIDER_KINDS) expect(text).toContain(`| ${kind} |`);
  });

  it("states retention from the catalog, not from prose", () => {
    expect(renderProcessingRecord()).toMatch(/\d+ months after the interview ends/);
  });

  it("marks the DPA template as a draft that needs counsel", () => {
    const dpa = doc("DPA-template.md");
    expect(dpa).toMatch(/draft/i);
    expect(dpa).toMatch(/counsel/i);
  });
});

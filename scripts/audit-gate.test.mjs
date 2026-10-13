import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate } from "./audit-gate.mjs";

const advisory = (id, severity, module = "pkg") => ({
  github_advisory_id: id,
  severity,
  module_name: module,
  title: "t",
  url: `https://github.com/advisories/${id}`,
});
const now = new Date("2026-10-13T00:00:00Z");

describe("audit gate", () => {
  it("passes when nothing blocking is present", () => {
    const r = evaluate(
      { advisories: { 1: advisory("GHSA-a", "moderate"), 2: advisory("GHSA-b", "low") } },
      {},
      now,
    );
    assert.equal(r.ok, true);
  });

  it("fails on a high or critical advisory with no ignore", () => {
    for (const severity of ["high", "critical"]) {
      const r = evaluate({ advisories: { 1: advisory("GHSA-a", severity) } }, { ignore: [] }, now);
      assert.equal(r.ok, false);
      assert.match(r.problems[0], new RegExp(severity));
    }
  });

  it("accepts an unexpired ignore that names a reason and an owner", () => {
    const ignore = [{ id: "GHSA-a", reason: "no fix yet", owner: "owner", expires: "2026-12-01" }];
    const r = evaluate({ advisories: { 1: advisory("GHSA-a", "high") } }, { ignore }, now);
    assert.equal(r.ok, true);
    assert.match(r.notes[0], /ignored until 2026-12-01/);
  });

  it("fails again once an ignore has expired", () => {
    const ignore = [{ id: "GHSA-a", reason: "no fix yet", owner: "owner", expires: "2026-10-01" }];
    const r = evaluate({ advisories: { 1: advisory("GHSA-a", "high") } }, { ignore }, now);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes("expired on 2026-10-01")));
  });

  it("rejects an ignore without a reason, owner or expiry", () => {
    const r = evaluate({ advisories: {} }, { ignore: [{ id: "GHSA-a" }] }, now);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /missing reason, owner, expires/);
  });

  it("says when an ignore no longer matches anything", () => {
    const ignore = [{ id: "GHSA-gone", reason: "r", owner: "o", expires: "2026-12-01" }];
    const r = evaluate({ advisories: {} }, { ignore }, now);
    assert.equal(r.ok, true);
    assert.match(r.notes[0], /no longer matches/);
  });
});

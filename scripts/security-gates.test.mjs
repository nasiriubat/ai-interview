import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateSecurityTxt, evaluateTrivyIgnore, unpinnedUses } from "./security-gates.mjs";

const now = new Date("2026-10-14T00:00:00Z");

describe("trivy ignore gate", () => {
  it("passes an empty file", () => {
    assert.equal(evaluateTrivyIgnore({ vulnerabilities: [] }, now).ok, true);
  });

  it("accepts a justified entry that expires soon", () => {
    const r = evaluateTrivyIgnore(
      {
        vulnerabilities: [
          {
            id: "CVE-2026-1",
            statement: "Not reachable: only the build stage uses it",
            expired_at: "2026-12-01",
          },
        ],
      },
      now,
    );
    assert.equal(r.ok, true);
    assert.match(r.notes[0], /carried until 2026-12-01/);
  });

  it("refuses an entry with no reason, no expiry, an expired one and one that lasts too long", () => {
    const r = evaluateTrivyIgnore(
      {
        vulnerabilities: [
          { id: "CVE-A", expired_at: "2026-12-01" },
          { id: "CVE-B", statement: "a reason that is long enough to count" },
          { id: "CVE-C", statement: "a reason that is long enough to count", expired_at: "2026-10-01" },
          { id: "CVE-D", statement: "a reason that is long enough to count", expired_at: "2028-01-01" },
        ],
      },
      now,
    );
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 4);
    assert.match(r.problems.join("\n"), /CVE-A.*statement/);
    assert.match(r.problems.join("\n"), /CVE-B.*expired_at/);
    assert.match(r.problems.join("\n"), /CVE-C.*expired on/);
    assert.match(r.problems.join("\n"), /CVE-D.*more than 180 days/);
  });
});

describe("workflow pins", () => {
  const sha = "34e114876b0b11c390a56381ad16ebd13914f8d5";

  it("accepts actions pinned by a full commit SHA, local actions and docker digests", () => {
    const text = [
      `      - uses: actions/checkout@${sha} # v4.3.1`,
      "      - uses: ./.github/actions/local",
      `      - uses: docker://alpine@sha256:${"a".repeat(64)}`,
    ].join("\n");
    assert.deepEqual(unpinnedUses(text), []);
  });

  it("refuses a tag, a branch, a short SHA and a missing ref", () => {
    const text = [
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@main",
      "      - uses: pnpm/action-setup@34e1148",
      "      - uses: some/action",
      "      - uses: docker://alpine:3",
    ].join("\n");
    assert.equal(unpinnedUses(text).length, 5);
  });

  it("ignores text that merely contains the word", () => {
    assert.deepEqual(unpinnedUses("      - run: echo uses: actions/checkout@v4"), []);
  });
});

describe("security.txt gate", () => {
  const good = "Contact: mailto:security@example.org\nExpires: 2027-05-01T00:00:00.000Z\n";

  it("passes a current file", () => {
    assert.equal(evaluateSecurityTxt(good, now).ok, true);
  });

  it("refuses a missing contact, a missing expiry, an expired file and a promise of years", () => {
    assert.equal(evaluateSecurityTxt("Expires: 2027-05-01T00:00:00Z\n", now).ok, false);
    assert.equal(evaluateSecurityTxt("Contact: mailto:a@b.c\n", now).ok, false);
    assert.equal(
      evaluateSecurityTxt("Contact: mailto:a@b.c\nExpires: 2026-01-01T00:00:00Z\n", now).ok,
      false,
    );
    assert.equal(
      evaluateSecurityTxt("Contact: mailto:a@b.c\nExpires: 2030-01-01T00:00:00Z\n", now).ok,
      false,
    );
  });

  it("notes, without failing, a placeholder contact and a file about to lapse", () => {
    const r = evaluateSecurityTxt(
      "Contact: mailto:security@<your-domain>\nExpires: 2026-10-30T00:00:00Z\n",
      now,
    );
    assert.equal(r.ok, true);
    assert.equal(r.notes.length, 2);
  });
});

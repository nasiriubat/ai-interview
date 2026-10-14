import { describe, expect, it } from "vitest";
import { withoutLeadingTitle } from "../../src/spec/markdown.js";

/* Simulation 2026-10-15: every section of the generated document showed its title twice. */
describe("withoutLeadingTitle", () => {
  it("drops a first heading that repeats the section title, whatever its level or case", () => {
    expect(
      withoutLeadingTitle(
        "### Product overview and problem\n\nReferrals arrive by fax.",
        "Product overview and problem",
      ),
    ).toBe("Referrals arrive by fax.");
    expect(withoutLeadingTitle("## MVP scope ##\nIn version one.", "MVP scope")).toBe("In version one.");
  });

  it("keeps a different first heading and plain prose as they are", () => {
    expect(withoutLeadingTitle("### Volumes\nAbout 25 a day.", "Product overview and problem")).toBe(
      "### Volumes\nAbout 25 a day.",
    );
    expect(withoutLeadingTitle("  Plain text.  ", "Anything")).toBe("Plain text.");
    expect(withoutLeadingTitle("", "Anything")).toBe("");
  });
});

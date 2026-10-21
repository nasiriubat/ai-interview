import { describe, expect, it } from "vitest";
import {
  checkFigures,
  matchQuote,
  MAX_ELLIPSIS_GAP,
  quoteTokens,
  type FigureFacts,
} from "../../src/analysis/verify.js";

/**
 * Evidence verification (D-478). The fixtures are what a participant said in one interview; each
 * quote is something an extractor might have attached to a fact from it.
 */
const TRANSCRIPT = [
  "Hi, I'm on the ward most mornings.",
  "Every morning I copy the lab results from the portal into our Excel sheet by hand, it takes me about forty minutes and I always worry I've mistyped a value.",
  "Then the doctor asks me for the same numbers again on the phone, so honestly half of my morning is gone before I've seen a patient.",
  "We tried a macro once but IT removed it.",
];

describe("quote verification", () => {
  it("accepts a verbatim quote, whatever its case, punctuation and quotation marks", () => {
    expect(
      matchQuote("I copy the lab results from the portal into our Excel sheet by hand", TRANSCRIPT).ok,
    ).toBe(true);
    expect(
      matchQuote("“Honestly, half of my morning is gone before I’ve seen a patient!”", TRANSCRIPT).ok,
    ).toBe(true);
    expect(matchQuote("WE TRIED A MACRO ONCE  but IT removed it", TRANSCRIPT).ok).toBe(true);
  });

  it("accepts a quote trimmed with an ellipsis, in order and within one message", () => {
    expect(
      matchQuote("I copy the lab results … by hand, it takes me about forty minutes", TRANSCRIPT).ok,
    ).toBe(true);
    expect(matchQuote("Every morning I copy the lab results [...] into our Excel sheet", TRANSCRIPT).ok).toBe(
      true,
    );
    // Out of order is a splice, not a trim.
    expect(
      matchQuote("by hand, it takes me about forty minutes ... I copy the lab results", TRANSCRIPT).ok,
    ).toBe(false);
    // Two messages glued together are not one quote.
    expect(matchQuote("We tried a macro once ... half of my morning is gone", TRANSCRIPT).ok).toBe(false);
  });

  it("allows a small slip: a typo, a dropped filler word", () => {
    // "honestly" dropped and "numbres" mistyped: 2 edits in 21 words is above the 85% threshold.
    expect(
      matchQuote(
        "the doctor asks me for the same numbres again on the phone, so half of my morning is gone before I've seen a patient",
        TRANSCRIPT,
      ).ok,
    ).toBe(true);
  });

  it("rejects a hallucinated quote", () => {
    const r = matchQuote("The lab portal crashes every single day and nobody fixes it", TRANSCRIPT);
    expect(r.ok).toBe(false);
    expect(r.score).toBeLessThan(0.5);
  });

  it("rejects a paraphrase, even one built from the participant's own words", () => {
    // Every content word occurs in the transcript; the sentence was never said.
    const r = matchQuote("Copying lab results by hand into Excel takes half of my morning", TRANSCRIPT);
    expect(r.ok).toBe(false);
    expect(matchQuote("I worry that I mistyped values when I copy the results", TRANSCRIPT).ok).toBe(false);
  });

  it("never verifies a quote of fewer than three words, and needs short segments exact", () => {
    expect(matchQuote("by hand", TRANSCRIPT).ok).toBe(false);
    expect(matchQuote("the lab results", TRANSCRIPT).ok).toBe(true);
    expect(matchQuote("the lab reports", TRANSCRIPT).ok).toBe(false);
  });

  it("does not let an ellipsis stand for more than a short trim", () => {
    const long = Array.from({ length: MAX_ELLIPSIS_GAP + 5 }, (_, i) => `word${i}`).join(" ");
    const said = [`it starts here ${long} and it ends here`];
    expect(matchQuote("it starts here ... and it ends here", said).ok).toBe(false);
    expect(
      matchQuote("it starts here ... and it ends here", [
        "it starts here, then a little later, and it ends here",
      ]).ok,
    ).toBe(true);
  });

  it("finds nothing in an empty or missing transcript", () => {
    expect(matchQuote("I copy the lab results", []).ok).toBe(false);
  });

  it("normalizes compatibility forms and apostrophes", () => {
    expect(quoteTokens("I’ve  ﬁled it… “done”")).toEqual(["ive", "filed", "it", "done"]);
  });
});

const FACTS: FigureFacts = {
  // invited 20, completed 12, analyzed 12, 11 people, started 15, k 3, threshold 10, a group of 4 and of 2
  counts: [20, 12, 11, 15, 3, 10, 4, 2],
  totals: [20, 12, 11, 15],
  hoursPerWeek: [38.5, 6],
};

describe("figure verification", () => {
  it("keeps sentences whose figures match what was computed", () => {
    const text =
      "Twelve interviews were completed out of 20 invited people. The problem was mentioned in 4 of 12 interviews. Together they spend about 38 hours per week on it.";
    const r = checkFigures(text, FACTS);
    expect(r.removed).toBe(0);
    expect(r.text).toBe(text);
    expect(r.checked).toBeGreaterThanOrEqual(4);
  });

  it("removes a sentence whose count does not match, and keeps the rest", () => {
    const r = checkFigures(
      "Staff lose time to double entry. It was raised in 9 of 12 interviews. A shared form would help.",
      FACTS,
    );
    expect(r.removed).toBe(1);
    expect(r.text).toBe("Staff lose time to double entry. A shared form would help.");
  });

  it("checks percentages of people against computed shares", () => {
    expect(checkFigures("A third (33% of participants) described it.", FACTS).removed).toBe(0); // 4 of 12
    expect(checkFigures("95% of employees described it.", FACTS).removed).toBe(1);
    // A share of something else is not a campaign figure.
    expect(checkFigures("It would cut errors by 80% in the lab.", FACTS).checked).toBe(0);
  });

  it("checks weekly hours with a tolerance, and leaves other durations alone", () => {
    expect(checkFigures("Roughly 40 hours a week go into it.", FACTS).removed).toBe(0);
    expect(checkFigures("It costs 120 hours per week across the ward.", FACTS).removed).toBe(1);
    expect(checkFigures("Each run takes 2 hours.", FACTS).checked).toBe(0);
  });

  it("accepts the anonymity and completion thresholds in comparisons", () => {
    expect(
      checkFigures("Quotes appear only where at least 3 participants are behind them.", FACTS).removed,
    ).toBe(0);
  });

  it("strikes the figure rather than emptying a text that is one sentence", () => {
    const r = checkFigures("Mentioned by 7 people.", FACTS, "[figure removed]");
    expect(r.removed).toBe(1);
    expect(r.text).toBe("Mentioned by [figure removed].");
  });

  it("does not read a score or a step number as a campaign figure", () => {
    expect(checkFigures("It scores 4 of 5 on impact. Step 3 is manual.", FACTS).checked).toBe(0);
  });
});

describe("shares are of people over people (D-479)", () => {
  // completed 10, analyzed 10, 10 people; no invitations (open link), 15 started; groups of 4 and 2.
  const TIGHT: FigureFacts = {
    counts: [10, 15, 3, 4, 2],
    totals: [10],
    shareNumerators: [10, 4, 2],
    pairs: [[10, 15]],
    hoursPerWeek: [],
  };

  it("accepts a group's count over the interviews or people", () => {
    expect(checkFigures("It came up in 4 of 10 interviews.", TIGHT).removed).toBe(0);
    expect(checkFigures("40% of participants described it.", TIGHT).removed).toBe(0);
  });

  it("rejects a share that only matches two unrelated campaign figures", () => {
    // 67% is 10 completed of 15 started: true of the campaign, not of any topic.
    expect(checkFigures("67% of participants described the approval delay.", TIGHT).removed).toBe(1);
    expect(checkFigures("It came up in 3 of 15 interviews.", TIGHT).removed).toBe(1);
    expect(checkFigures("30% of participants described it.", TIGHT).removed).toBe(1);
  });

  it("still accepts the participation pair stated as N of M", () => {
    expect(checkFigures("10 of 15 people who started completed the interview.", TIGHT).removed).toBe(0);
  });
});

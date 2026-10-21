import { describe, expect, it } from "vitest";
import { checkQuote, extractQuotes, normalizeText } from "../src/grade/quotes.js";

const answers = [
  "I type every PDF invoice into Procountor by hand, it takes about three hours a day.",
  "Luen yövuoron paperisen vuoronvaihtolomakkeen, ja käsiala on usein lukukelvotonta.",
];

describe("normalizeText", () => {
  it("ignores case, punctuation and typographic quotes but keeps Finnish letters", () => {
    expect(normalizeText("“Käsiala” on, USEIN — lukukelvotonta!")).toBe("käsiala on usein lukukelvotonta");
  });
});

describe("extractQuotes", () => {
  it("collects each blockquote line, inline quotes outside code fences of four or more words and the items' own quotes, once each", () => {
    const quotes = extractQuotes({
      markdown: [
        "Intro with a “short phrase” and “a longer phrase of five words”.",
        "",
        "> I type every PDF invoice into Procountor by hand — accounts payable clerk",
        '> "Approvals wait six days"',
        "```mermaid",
        'flowchart LR; a["Export invoice data from Procountor"]',
        "```",
      ].join("\n"),
      opportunities: [{ quotes: ["I type every PDF invoice into Procountor by hand", "too short"] } as never],
    });
    expect(quotes).toEqual([
      "a longer phrase of five words",
      "I type every PDF invoice into Procountor by hand",
      "Approvals wait six days",
    ]);
  });
});

describe("checkQuote", () => {
  it("accepts a verbatim quote whatever the case and punctuation", () => {
    expect(checkQuote("i type every PDF invoice into procountor, by hand", answers).verdict).toBe("verbatim");
  });

  it("accepts an ellipsis when every piece is present in order in one answer", () => {
    expect(checkQuote("I type every PDF invoice … about three hours a day", answers).verdict).toBe(
      "verbatim",
    );
    expect(checkQuote("about three hours a day ... I type every PDF invoice", answers).verdict).not.toBe(
      "verbatim",
    );
  });

  it("matches a Finnish quote as Finnish", () => {
    expect(checkQuote("käsiala on usein lukukelvotonta", answers).verdict).toBe("verbatim");
  });

  it("calls a lightly edited quote near-verbatim and a paraphrase not found", () => {
    const near = checkQuote("I type every single PDF invoice into Procountor by hand", answers);
    expect(near.verdict).toBe("near_verbatim");
    expect(near.coverage).toBe(0.9);
    expect(checkQuote("Invoices are manually entered into the accounting system", answers).verdict).toBe(
      "not_found",
    );
  });

  it("does not accept the interviewer's words: only answers are searched", () => {
    expect(checkQuote("What takes most of your day", answers).verdict).toBe("not_found");
  });
});

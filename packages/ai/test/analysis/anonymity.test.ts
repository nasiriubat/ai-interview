import { describe, expect, it } from "vitest";
import {
  commonValues,
  genericizeTerms,
  isSelfIdentifying,
  stripSingling,
} from "../../src/analysis/anonymity.js";

describe("self-identifying quotes (D-479)", () => {
  it.each([
    "I'm the only one who knows how to do it",
    "I am the sole person handling payroll",
    "nobody else can read that template",
    "only me, really, nobody checks it",
    "I built the Excel template myself",
    "I've been here for 22 years and seen it all",
    "Minä olen ainoa, joka osaa tämän",
    "kukaan muu ei tiedä miten se tehdään",
    "vain minä teen sen",
    "tein sen pohjan itse",
  ])("flags %j", (quote) => {
    expect(isSelfIdentifying(quote)).toBe(true);
  });

  it.each([
    "we type the same numbers twice",
    "the only problem is the approval delay",
    "I check it every morning",
    "it takes about two days a month",
    "Sama asia kirjoitetaan kahteen kertaan",
  ])("leaves %j alone", (quote) => {
    expect(isSelfIdentifying(quote)).toBe(false);
  });
});

describe("sentences that single a person out (D-479)", () => {
  it("removes them and keeps the rest", () => {
    const r = stripSingling(
      "The check is manual. She is the only one who knows the procedure. A shared checklist would help.",
    );
    expect(r).toEqual({ text: "The check is manual. A shared checklist would help.", removed: 1 });
  });

  it("catches the usual phrasings in English and Finnish", () => {
    for (const s of [
      "Only one person knows how the template works.",
      "The sole employee who handles it is often away.",
      "Nobody else can cover the task.",
      "The monthly check depends on a single person.",
      "When she is on holiday the check does not happen.",
      "Ainoa henkilö, joka osaa tarkistuksen, on usein lomalla.",
      "Vain yksi henkilö osaa tehdä tarkistuksen.",
    ])
      expect(stripSingling(`Intro. ${s}`).removed).toBe(1);
  });

  it("leaves counts and ordinary uses of 'only' alone", () => {
    for (const s of [
      "Mentioned in only one interview.",
      "Only one of the approval steps is tracked.",
      "The only manual step is the export.",
    ])
      expect(stripSingling(s).removed).toBe(0);
  });

  it("does not empty a field that is a single such sentence", () => {
    expect(stripSingling("She is the only one who knows it.")).toEqual({
      text: "She is the only one who knows it.",
      removed: 0,
    });
  });
});

describe("breakdown values shared by k people (D-479)", () => {
  it("counts distinct people, case-insensitively, ignoring blanks", () => {
    const set = commonValues(
      [
        { participantKey: "p1", values: ["Excel", "HubSpot"] },
        { participantKey: "p1", values: ["excel"] },
        { participantKey: "p2", values: ["Excel", ""] },
        { participantKey: "p3", values: ["EXCEL", undefined] },
      ],
      3,
    );
    expect([...set]).toEqual(["excel"]);
  });

  it("names rare tools generically, whole words only", () => {
    expect(genericizeTerms("Offers are built in HubSpot; HubSpotter is unrelated.", ["HubSpot"], "en")).toBe(
      "Offers are built in a tool; HubSpotter is unrelated.",
    );
    expect(genericizeTerms("Orders stay outside the TMS.", ["TMS"], "en")).toBe(
      "Orders stay outside a tool.",
    );
    expect(genericizeTerms("Tarjoukset tehdään HubSpotissa ja HubSpot-pohjalla.", ["HubSpot"], "fi")).toBe(
      "Tarjoukset tehdään työkalu ja työkalu-pohjalla.",
    );
  });
});

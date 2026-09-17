import type { Widget } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import {
  clipToSentence,
  MAX_SPOKEN_CHARS,
  plainSpeech,
  readableList,
  speakWidget,
  toSpokenTurn,
} from "../../src/voice/speech.js";

describe("plainSpeech", () => {
  it("removes markup a speech model would otherwise pronounce", () => {
    expect(plainSpeech("**Really?** That sounds _slow_.")).toBe("Really? That sounds slow.");
    expect(plainSpeech("# Heading\n\nBody text.")).toBe("Heading Body text.");
    expect(plainSpeech("- one\n- two")).toBe("one two");
    expect(plainSpeech("1. first\n2. second")).toBe("first second");
    expect(plainSpeech("> quoted line")).toBe("quoted line");
  });

  it("keeps the words out of a link and drops the address", () => {
    expect(plainSpeech("See [the rota](https://intra.example/rota) for that.")).toBe(
      "See the rota for that.",
    );
  });

  it("drops a code block entirely, which is unspeakable either way", () => {
    expect(plainSpeech("Try this:\n```\nSELECT * FROM x;\n```\nDid it work?")).toBe("Try this: Did it work?");
  });

  it("leaves ordinary punctuation and numbers alone", () => {
    const said = "It takes 45 minutes, twice a shift — is that right?";
    expect(plainSpeech(said)).toBe(said);
  });

  it("does not eat an asterisk inside a word", () => {
    expect(plainSpeech("the file is report*.csv here")).toContain("report*.csv");
  });
});

describe("speakWidget", () => {
  const options = (n: number): { key: string; label: string; detail?: string }[] =>
    Array.from({ length: n }, (_, i) => ({
      key: `k${i}`,
      label: `Option ${i}`,
      detail: `A long explanation of option ${i} that nobody wants read aloud`,
    }));

  it("reads a short choice as a spoken question, never its option details", () => {
    const widget = { type: "single_choice", options: options(3) } as Widget;

    const out = speakWidget(widget);

    expect(out.text).toContain("Option 0, Option 1 or Option 2");
    expect(out.text).not.toContain("long explanation");
    expect(out.shortened).toBe(false);
  });

  it("invites free speech rather than reading out a long list", () => {
    // Seven options spoken in full is a memory test, not a question.
    const widget = { type: "single_choice", options: options(7) } as Widget;

    const out = speakWidget(widget);

    expect(out.text).toContain("7 options on screen");
    expect(out.text).toMatch(/your own words/i);
    expect(out.shortened).toBe(true);
  });

  it("says a multi-choice allows more than one", () => {
    const widget = { type: "multi_choice", options: options(3) } as Widget;

    expect(speakWidget(widget).text).toMatch(/more than one/i);
  });

  it("reads a scale with its end labels, which are what make it answerable aloud", () => {
    const widget = {
      type: "scale",
      min: 1,
      max: 5,
      minLabel: "never",
      maxLabel: "every day",
    } as Widget;

    const out = speakWidget(widget);

    expect(out.text).toContain("from 1 to 5");
    expect(out.text).toContain("1 is never");
    expect(out.text).toContain("5 is every day");
  });

  it("turns a ranking into a first question rather than a spoken sorting task", () => {
    const widget = { type: "ranking", options: options(4) } as Widget;

    const out = speakWidget(widget);

    expect(out.text).toMatch(/which matters most/i);
    expect(out.shortened).toBe(true);
  });

  it("asks yes or no plainly", () => {
    expect(speakWidget({ type: "yes_no" }).text).toBe("Yes or no?");
  });
});

describe("toSpokenTurn", () => {
  it("prefers the model's own short form, which knows what it meant to ask", () => {
    const out = toSpokenTurn(
      "Looking at the whole week, roughly what share of your time goes on re-entering data that already exists somewhere else?",
      undefined,
      "Roughly how much of your week goes on retyping?",
    );

    expect(out.text).toBe("Roughly how much of your week goes on retyping?");
  });

  it("falls back to the written message when no short form was given", () => {
    expect(toSpokenTurn("What happens next?").text).toBe("What happens next?");
  });

  it("ignores an empty short form rather than speaking nothing", () => {
    expect(toSpokenTurn("What happens next?", undefined, "   ").text).toBe("What happens next?");
  });

  it("appends the widget's spoken form to the question", () => {
    const out = toSpokenTurn("Does that happen often?", { type: "yes_no" });

    expect(out.text).toBe("Does that happen often? Yes or no?");
  });

  it("stays under the spoken length limit", () => {
    const long = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i}.`).join(" ");

    const out = toSpokenTurn(long);

    expect(out.text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(out.shortened).toBe(true);
  });

  it("reports that it shortened, so the interface can point at the screen", () => {
    const options = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, label: `L${i}` }));

    const out = toSpokenTurn("Which is it?", { type: "single_choice", options });

    expect(out.shortened).toBe(true);
  });
});

describe("clipToSentence", () => {
  it("cuts on a sentence boundary, never mid-sentence", () => {
    // 20 characters: the first sentence fits, the second would not.
    const out = clipToSentence("One two three. Four five six. Seven eight nine.", 20);

    expect(out.text).toBe("One two three.");
    expect(out.shortened).toBe(true);
  });

  it("speaks the whole first sentence even when it alone is over the limit", () => {
    // A truncated question is not a question; better to run long than to stop at random.
    const out = clipToSentence("A single very long sentence that runs past the limit entirely.", 10);

    expect(out.text).toBe("A single very long sentence that runs past the limit entirely.");
    expect(out.shortened).toBe(true);
  });

  it("leaves short text alone and says so", () => {
    expect(clipToSentence("Short.", 100)).toEqual({ text: "Short.", shortened: false });
  });
});

describe("readableList", () => {
  it("joins with the conjunction a spoken list needs", () => {
    expect(readableList(["a"])).toBe("a");
    expect(readableList(["a", "b"])).toBe("a or b");
    expect(readableList(["a", "b", "c"])).toBe("a, b or c");
    expect(readableList([])).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import {
  containsQuote,
  costCents,
  extractJson,
  flagMessage,
  parseDotenv,
  percentile,
  pickModel,
  redactSecrets,
  SseParser,
  totalFlags,
  type ListedModel,
} from "../src/pure.js";

const model = (over: Partial<ListedModel> & { id: string }): ListedModel => ({
  contextLength: 200_000,
  inputPerMtok: 0.1,
  outputPerMtok: 0.5,
  maxCompletionTokens: null,
  supportsStructured: true,
  textOnly: true,
  ...over,
});

describe("SseParser", () => {
  it("emits whole events across arbitrary chunk boundaries", () => {
    const p = new SseParser();
    const a = p.push('event: text\ndata: {"delta":"Hel');
    const b = p.push('lo"}\n\nevent: turn\ndata: {"ended":false}\n\n');
    expect(a).toEqual([]);
    expect(b).toEqual([
      { event: "text", data: { delta: "Hello" } },
      { event: "turn", data: { ended: false } },
    ]);
  });
  it("ignores comments and handles CRLF", () => {
    const p = new SseParser();
    expect(p.push(': ping\r\n\r\nevent: ended\r\ndata: {"summaryAvailable":true}\r\n\r\n')).toEqual([
      { event: "ended", data: { summaryAvailable: true } },
    ]);
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("flagMessage", () => {
  it("flags two questions in one message", () => {
    expect(flagMessage("What do you do first? And who gets the result?", 500).multiQuestion).toBe(true);
    expect(flagMessage("Walk me through yesterday morning.", 500).multiQuestion).toBe(false);
  });
  it("flags suggested solutions and the where-should-AI-go question", () => {
    expect(flagMessage("Have you considered a chatbot for that?", 500).suggestsSolution).toBe(true);
    expect(flagMessage("You could try a shared spreadsheet.", 500).suggestsSolution).toBe(true);
    expect(flagMessage("How long was it held up before you could start?", 500).suggestsSolution).toBe(false);
    expect(flagMessage("Where would you use AI in your day?", 500).asksWhereAiGoes).toBe(true);
    expect(flagMessage("How long did the export take last time?", 500)).toMatchObject({
      suggestsSolution: false,
      asksWhereAiGoes: false,
      leading: false,
    });
  });
  it("flags leading phrasing and length", () => {
    expect(flagMessage("That must be so frustrating, doesn't it slow you down?", 500).leading).toBe(true);
    expect(flagMessage("x".repeat(501), 500).overLength).toBe(true);
  });
  it("totals", () => {
    const t = totalFlags(["One? Two?", "Fine."], 500);
    expect(t).toMatchObject({ messages: 2, multiQuestion: 1 });
  });
});

describe("pickModel", () => {
  const list = [
    model({ id: "a/preferred", inputPerMtok: 0.3 }),
    model({ id: "b/cheap", inputPerMtok: 0.05, outputPerMtok: 0.1 }),
    model({ id: "c/small-context", contextLength: 8000, inputPerMtok: 0.01 }),
    model({ id: "d/batch:batch", inputPerMtok: 0.01 }),
  ];
  const need = { prefer: ["a/preferred"], minContext: 128_000, maxInputPerMtok: 1, maxOutputPerMtok: 3 };
  it("honours preference order when the model fits", () => {
    expect(pickModel(list, need)?.id).toBe("a/preferred");
  });
  it("falls back to the cheapest structured-output model that fits", () => {
    expect(pickModel(list, { ...need, prefer: ["missing/model"] })?.id).toBe("b/cheap");
  });
  it("never picks over the price ceiling", () => {
    expect(pickModel(list, { ...need, maxInputPerMtok: 0.02 })).toBeNull();
  });
});

describe("secrets", () => {
  it("redacts known values and key-shaped strings", () => {
    const out = redactSecrets("failed with key abcdefgh12345678 and sk-or-v1-abcdefghijklmnopqrst", [
      "abcdefgh12345678",
    ]);
    expect(out).not.toContain("abcdefgh12345678");
    expect(out).not.toContain("sk-or-v1");
  });
  it("parses dotenv without expanding or leaking comments", () => {
    expect(parseDotenv('# c\nA=1\nB="two words"\nC=3 # note\nbad line')).toEqual({
      A: "1",
      B: "two words",
      C: "3",
    });
  });
});

describe("misc", () => {
  it("computes cents from per-million prices", () => {
    expect(costCents(1_000_000, 500_000, 0.1, 0.5)).toBeCloseTo(35, 5);
  });
  it("finds a quote regardless of punctuation and case", () => {
    expect(
      containsQuote(
        "She said: “We copy the numbers by hand, twice a day.”",
        "we copy the numbers by hand twice a day",
      ),
    ).toBe(true);
    expect(containsQuote("short", "short")).toBe(false);
  });
  it("extracts JSON from prose and fences", () => {
    expect(extractJson('Sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson("no json")).toBeNull();
  });
});

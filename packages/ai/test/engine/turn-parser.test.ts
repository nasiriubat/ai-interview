import { describe, expect, it } from "vitest";
import { TurnParser, extractJsonObject } from "../../src/engine/turn-parser.js";

describe("TurnParser", () => {
  it("emits message text as it streams and never leaks a partial marker", () => {
    const p = new TurnParser();
    const full = 'Hello there, what do you do?\n<<<TURN_META>>>\n{"areaKey":"role","reason":"start"}';
    let shown = "";
    for (let i = 0; i < full.length; i += 3) shown += p.push(full.slice(i, i + 3));
    expect(shown).not.toContain("<<<");
    const r = p.finish();
    expect(shown + r.rest).toBe("Hello there, what do you do?\n");
    expect(r.message).toBe("Hello there, what do you do?");
    expect(r.meta.areaKey).toBe("role");
    expect(r.error).toBeUndefined();
  });

  it("returns the whole text as the message when the marker is missing", () => {
    const p = new TurnParser();
    const shown = p.push("Just a question?");
    const r = p.finish();
    expect(shown + r.rest).toBe("Just a question?");
    expect(r.error).toBe("missing marker");
  });

  it("tolerates code fences and invalid widget shapes by dropping the metadata", () => {
    const p = new TurnParser();
    p.push('Q?\n<<<TURN_META>>>\n```json\n{"widget":{"type":"scale","min":2}}\n```');
    const r = p.finish();
    expect(r.message).toBe("Q?");
    expect(r.error).toBeDefined();
    expect(extractJsonObject('x {"a":"}"} y')).toBe('{"a":"}"}');
  });
});

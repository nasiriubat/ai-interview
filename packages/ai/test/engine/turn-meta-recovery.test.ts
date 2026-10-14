import { describe, expect, it } from "vitest";
import { InterviewEngine } from "../../src/engine/engine.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { LexicalRecall } from "../../src/engine/recall.js";
import { TurnParser } from "../../src/engine/turn-parser.js";
import { MemoryStore, ScriptedCaller, settings, snapshot, template } from "./helpers.js";

const logger = { warn: () => undefined, info: () => undefined };

/** Feeds `full` in small chunks like a stream; returns what the participant would see and the result. */
function stream(full: string, chunk = 3) {
  const p = new TurnParser();
  let shown = "";
  for (let i = 0; i < full.length; i += chunk) shown += p.push(full.slice(i, i + chunk));
  const r = p.finish();
  return { shown: shown + r.rest, r };
}

const META = '{"areaKey":"role","reason":"start","stateDelta":{"coverage":{"role":{"status":"partial"}}}}';

describe("TurnParser tolerates the marker the way models write it (live run: 29 lost deltas)", () => {
  it.each([
    ["two brackets", "<<TURN_META>>"],
    ["lower case", "<<<turn_meta>>>"],
    ["spaces", "<<< TURN_META >>>"],
    ["no closing brackets", "<<<TURN_META"],
    ["a bare label", "TURN_META:"],
    ["a bold label", "**TURN_META**:"],
  ])("accepts %s", (_name, marker) => {
    const { shown, r } = stream(`What is your role?\n${marker}\n${META}`);
    expect(r.error).toBeUndefined();
    expect(r.meta.areaKey).toBe("role");
    expect(r.message).toBe("What is your role?");
    expect(shown).not.toMatch(/TURN_META|turn_meta|<<|\{/);
  });

  it("recovers a metadata object that arrives without any marker, and keeps it off the screen", () => {
    const { shown, r } = stream(`What is your role?\n${META}`, 5);
    expect(r.error).toBeUndefined();
    expect(r.meta.areaKey).toBe("role");
    expect(r.message).toBe("What is your role?");
    expect(shown.trim()).toBe("What is your role?");
  });

  it("recovers a fenced object without a marker", () => {
    const { shown, r } = stream(`What is your role?\n\`\`\`json\n${META}\n\`\`\``, 4);
    expect(r.meta.areaKey).toBe("role");
    expect(shown).not.toContain("```");
    expect(r.message).toBe("What is your role?");
  });

  it("does not mistake the participant-facing prose for metadata", () => {
    const text = 'Could you show me the "reason" field {as you see it} on the TURN sheet?';
    const { shown, r } = stream(text, 4);
    expect(r.error).toBe("missing marker");
    expect(shown).toBe(text);
  });

  it("keeps the state delta when only the widget is malformed", () => {
    const { r } = stream(
      'Q?\n<<<TURN_META>>>\n{"areaKey":"role","widget":{"type":"scale","min":2},"stateDelta":{"coverage":{"role":{"status":"partial"}}}}',
    );
    expect(r.error).toMatch(/widget/);
    expect(r.meta.areaKey).toBe("role");
    expect(r.meta.stateDelta).toBeDefined();
    expect(r.meta.widget).toBeUndefined();
  });
});

describe("the engine asks for the metadata once when a reply carries none", () => {
  const engineFor = (store: MemoryStore, caller: ScriptedCaller) =>
    new InterviewEngine({
      caller: caller.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger,
    });

  async function runTurn(engine: InterviewEngine, store: MemoryStore) {
    const gen = engine.nextTurn(snapshot(template(), store.state), undefined, settings);
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    return r.value;
  }

  it("repairs coverage from a reply with no marker and no JSON", async () => {
    const store = new MemoryStore();
    const caller = new ScriptedCaller([
      "Hi! To start, what is your role?",
      JSON.stringify({
        areaKey: "role",
        reason: "open role",
        stateDelta: { coverage: { role: { status: "partial", known: "", missing: "role" } } },
      }),
    ]);
    const result = await runTurn(engineFor(store, caller), store);
    expect(caller.requests.map((q) => q.purpose)).toEqual(["interview_turn", "interview_turn"]);
    expect(String(caller.requests[1]?.req.system)).toContain("bookkeeping of one interview turn");
    expect(result.state.coverage.role?.status).toBe("partial");
    expect(store.messages[0]?.content).toBe("Hi! To start, what is your role?");
  });

  it("does not spend a repair call when the reply carried its metadata", async () => {
    const store = new MemoryStore();
    const caller = new ScriptedCaller([`Hi! What is your role?\n<<turn_meta>>\n${META}`]);
    const result = await runTurn(engineFor(store, caller), store);
    expect(caller.requests).toHaveLength(1);
    expect(result.state.coverage.role?.status).toBe("partial");
  });

  it("carries on with the message alone when the repair call fails", async () => {
    const store = new MemoryStore();
    const caller = new ScriptedCaller(["Hi! What is your role?", "not json at all"]);
    const result = await runTurn(engineFor(store, caller), store);
    expect(result.state.turnCount).toBe(1);
    expect(store.messages).toHaveLength(1);
  });
});

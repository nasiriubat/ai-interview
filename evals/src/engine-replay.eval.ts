import {
  InterviewEngine,
  LexicalRecall,
  ShippedPromptSource,
  type EngineEvent,
  type NewMessage,
  type SessionSnapshot,
  type SessionStore,
  type StoredMessage,
} from "@aidp/ai";
import { shippedTemplate } from "@aidp/db";
import { SessionStateSchema, type SessionState } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/ward-nurse.json" with { type: "json" };
import { IdealScriptedModel } from "./model-script.js";

class MemoryStore implements SessionStore {
  messages: StoredMessage[] = [];
  state: SessionState = SessionStateSchema.parse({});
  async appendMessage(_id: string, m: NewMessage): Promise<StoredMessage> {
    const s: StoredMessage = {
      ...m,
      id: String(this.messages.length + 1),
      seq: this.messages.length + 1,
      createdAt: new Date(),
    };
    this.messages.push(s);
    return s;
  }
  async recentMessages(_id: string, limit: number) {
    return this.messages.slice(-limit);
  }
  async messagesAfter(_id: string, seq: number) {
    return this.messages.filter((m) => m.seq > seq);
  }
  async saveState(_id: string, state: SessionState) {
    this.state = state;
  }
  async saveSummary() {}
  async appendEvent() {}
}

const settings = {
  recentWindowTurns: 10,
  inputTokenBudget: 12000,
  summarizeEveryTurns: 6,
  extractEveryTurns: 3,
  maxTurns: 60,
};

describe(`engine replay: ${fixture.name}`, () => {
  it("covers every area in template order and ends with closing and summary within the turn budget", async () => {
    const template = shippedTemplate(fixture.templateKey);
    expect(template).toBeDefined();
    if (!template) return;
    const store = new MemoryStore();
    const model = new IdealScriptedModel(template);
    const engine = new InterviewEngine({
      caller: model.asCaller(),
      store,
      prompts: new ShippedPromptSource(),
      recall: new LexicalRecall(store, 10),
      logger: { warn: () => undefined, info: () => undefined },
    });
    const session: SessionSnapshot = {
      id: "eval",
      companyId: "c",
      template,
      state: store.state,
      summary: "",
    };

    const focuses: string[] = [];
    const run = async (answer?: string) => {
      const gen = engine.nextTurn(
        { ...session, state: store.state },
        answer ? { content: answer, modality: "text" } : undefined,
        settings,
      );
      let r = await gen.next();
      while (!r.done) {
        const ev: EngineEvent = r.value;
        if (ev.type === "turn")
          focuses.push(
            ev.focus.mode === "context"
              ? "context"
              : "areaKey" in ev.focus
                ? `${ev.focus.mode}:${ev.focus.areaKey}`
                : ev.focus.mode,
          );
        r = await gen.next();
      }
      return r.value;
    };

    let result = await run();
    expect(focuses[0]).toBe(`area:${fixture.expect.firstFocus}`);
    let turns = 1;
    for (const answer of fixture.answers) {
      if (result.ended) break;
      result = await run(answer);
      turns++;
    }
    while (!result.ended && turns < fixture.expect.maxTurns + 2) {
      result = await run("No, that is all.");
      turns++;
    }
    expect(result.ended).toBe(true);
    expect(turns).toBeLessThanOrEqual(fixture.expect.maxTurns);
    for (const key of fixture.expect.coveredByEnd)
      expect(store.state.coverage[key]?.status, key).toBe("covered");
    // Areas open in template order: first mention of each key is monotone in template order.
    const order = template.coverageAreas.map((a) => a.key);
    const firstSeen = order.map((k) => focuses.findIndex((f) => f.endsWith(`:${k}`))).filter((i) => i >= 0);
    expect([...firstSeen].sort((a, b) => a - b)).toEqual(firstSeen);
    expect(focuses.at(-2)).toBe("closing");
    expect(focuses.at(-1)).toBe("summary");
    // The stable prefix never changed across turns: the cache can hit.
    expect(new Set(model.requests.map((r) => r.system)).size).toBe(1);
  });
});

import {
  InterviewEngine,
  LexicalRecall,
  ShippedPromptSource,
  renderLiveSpec,
  type EngineEvent,
  type NewMessage,
  type SessionSnapshot,
  type SessionStore,
  type StoredMessage,
} from "@aidp/ai";
import { shippedTemplate } from "@aidp/db";
import { SessionStateSchema, type Path, type SessionState } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/charting-nontechnical.json" with { type: "json" };
import { RequirementsScriptedModel } from "./requirements-model.js";

class MemoryStore implements SessionStore {
  messages: StoredMessage[] = [];
  state: SessionState = SessionStateSchema.parse({});
  events: { type: string; payload: unknown }[] = [];
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
  async saveSummary(): Promise<void> {
    // summaries are not exercised by this eval
  }
  async appendEvent(_id: string, type: string, payload: unknown): Promise<void> {
    this.events.push({ type, payload });
  }
}

const settings = {
  recentWindowTurns: 10,
  inputTokenBudget: 12000,
  summarizeEveryTurns: 6,
  extractEveryTurns: 3,
  maxTurns: 120,
};

const focusLabel = (f: EngineEvent & { type: "turn" }): string => {
  const focus = f.focus;
  switch (focus.mode) {
    case "context":
      return `context:${focus.questionKey}`;
    case "finding":
      return `finding:${focus.findingId}${focus.pushBack ? ":pushback" : ""}`;
    case "mvp_challenge":
      return `mvp:${focus.itemPath}`;
    default:
      return "areaKey" in focus ? `${focus.mode}:${focus.areaKey}` : focus.mode;
  }
};

describe(`requirements replay: ${fixture.name}`, () => {
  it("runs the context block, path-filtered areas, a finding, the MVP challenge, then closing and summary; the spec grows every turn", async () => {
    const template = shippedTemplate(fixture.templateKey);
    expect(template).toBeDefined();
    if (!template) return;
    const store = new MemoryStore();
    const model = new RequirementsScriptedModel(template);
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
      path: fixture.path as Path,
    };

    const focuses: string[] = [];
    const fieldCounts: number[] = [];
    const run = async (answer?: string) => {
      const gen = engine.nextTurn(
        { ...session, state: store.state },
        answer ? { content: answer, modality: "text" } : undefined,
        settings,
      );
      let r = await gen.next();
      while (!r.done) {
        const ev: EngineEvent = r.value;
        if (ev.type === "turn") {
          focuses.push(focusLabel(ev));
          fieldCounts.push(
            renderLiveSpec({ title: "t", path: session.path, state: ev.state, edits: {} }).stats.fields,
          );
        }
        r = await gen.next();
      }
      return r.value;
    };

    let result = await run();
    expect(focuses[0]).toBe(fixture.expect.firstFocus);
    let turns = 1;
    for (const answer of fixture.answers) {
      if (result.ended) break;
      result = await run(answer);
      turns++;
    }
    while (!result.ended && turns < fixture.expect.maxTurns + 2) {
      result = await run("Yes, that is right, go on.");
      turns++;
    }
    expect(result.ended).toBe(true);
    expect(turns).toBeLessThanOrEqual(fixture.expect.maxTurns);

    // Context block first, in template order, before any area.
    const contextFocuses = focuses.slice(0, fixture.expect.contextKeys.length);
    expect(contextFocuses).toEqual(fixture.expect.contextKeys.map((k) => `context:${k}`));
    expect(focuses.findIndex((f) => f.startsWith("area:"))).toBe(fixture.expect.contextKeys.length);

    for (const key of fixture.expect.coveredByEnd)
      expect(store.state.coverage[key]?.status, key).toBe("covered");
    for (const key of fixture.expect.neverFocused)
      expect(
        focuses.some((f) => f.endsWith(`:${key}`)),
        key,
      ).toBe(false);

    // Areas open in template order.
    const order = template.coverageAreas.map((a) => a.key);
    const firstSeen = order
      .map((k) => focuses.findIndex((f) => f.startsWith("area:") && f.endsWith(`:${k}`)))
      .filter((i) => i >= 0);
    expect([...firstSeen].sort((a, b) => a - b)).toEqual(firstSeen);

    // The issue-detection pass ran over the spec state, never the transcript; its finding was raised then settled.
    expect(model.issueScans.length).toBeGreaterThanOrEqual(1);
    expect(model.issueScans[0]).toContain("Specification state");
    expect(model.issueScans[0]).not.toContain("Let's talk about");
    const raised = focuses.filter((f) => f.startsWith("finding:"));
    expect(raised).toHaveLength(1);
    expect(store.state.findings).toHaveLength(1);
    expect(store.state.findings[0]?.status).toBe("resolved");

    // The MVP challenge walked both functional requirements after the last area and before closing, and moved one to future scope.
    const mvp = focuses.filter((f) => f.startsWith("mvp:"));
    expect(mvp).toEqual(["mvp:FR-1", "mvp:FR-2"]);
    const lastArea = focuses.map((f) => f.startsWith("area:") || f.startsWith("continue:")).lastIndexOf(true);
    expect(focuses.indexOf("mvp:FR-1")).toBeGreaterThan(lastArea);
    expect(focuses.indexOf("mvp:FR-1")).toBeLessThan(focuses.indexOf("closing"));
    expect(store.state.mvpChallenge).toEqual({ started: true, done: true, asked: ["FR-1", "FR-2"] });
    const live = renderLiveSpec({ title: "t", path: session.path, state: store.state, edits: {} });
    const functional = live.sections.find((s) => s.key === "functional");
    expect(functional?.markdown).toContain("- **FR-1** (mvp)");
    expect(functional?.markdown).toContain("- **FR-2** (future)");
    expect(live.sections.find((s) => s.key === "technical")?.status).toBe("draft"); // technical_recommended maps here
    expect(live.context).toHaveProperty("compliance");

    // The live spec never shrinks from one turn to the next (FR-22).
    for (let i = 1; i < fieldCounts.length; i++)
      expect(fieldCounts[i]).toBeGreaterThanOrEqual(fieldCounts[i - 1] ?? 0);

    expect(focuses.at(-2)).toBe("closing");
    expect(focuses.at(-1)).toBe("summary");
    // The stable prefix never changed across interview turns: the cache can hit.
    expect(
      new Set(model.requests.filter((r) => r.purpose === "interview_turn").map((r) => r.req.system)).size,
    ).toBe(1);
  });
});

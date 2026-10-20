import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { WebSocket as WsClient } from "ws";
import { startFakeProvider, type FakeProvider } from "../../../tools/fake-provider/src/server.js";
import { fakeModelServer, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

/**
 * Speech starts on the first sentence of the reply, not after its metadata (D-280).
 *
 * The model here streams at 250 characters a second, a realistic 60 tokens a second. The reply is
 * four sentences and a metadata object, about 2.2 seconds end to end; the first sentence is on the
 * wire after a quarter of a second. Before the change, `first_word` was bounded by the whole reply.
 */
const SENTENCES = [
  "Thank you, that is a very clear picture of the morning.",
  "Let me make sure I have the order of events right before we move on.",
  "When the figures arrive from the ward, who is the first person to see them?",
  "And what do they do with them next?",
];
const MESSAGE = SENTENCES.join(" ");
const REPLY = `${MESSAGE}\n${TURN_MARKER}\n${JSON.stringify({
  areaKey: "daily",
  reason: "The participant described the morning and the interviewer wants the hand-off.",
  stateDelta: {
    coverage: { daily: { status: "partial", notes: "morning routine described in some detail" } },
  },
})}`;

describeDb("voice: the first sentence is spoken while the metadata is written", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[] };
  let port = 0;

  beforeAll(async () => {
    model = await fakeModelServer(() => REPLY, undefined, undefined, undefined, 250);
    world = await testWorld(model.url);
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: {
        authorization: `Bearer ${world.operatorToken}`,
        "x-company-id": world.companyId,
        "content-type": "application/json",
      },
      payload: { scope: "tenant", values: { "features.realtimeVoice": true } },
    });
    await world.db.setting.create({
      data: {
        scope: "tenant",
        scopeId: world.companyId,
        companyId: world.companyId,
        key: "ceiling.maxActiveCampaigns",
        value: 0,
      },
    });
    const provider = await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } });
    await world.db.route.create({
      data: {
        companyId: world.companyId,
        purpose: "tts",
        providerId: provider.id,
        model: "fake-voice",
        maxOutputTokens: 800,
      },
    });
    await world.app.listen({ port: 0, host: "127.0.0.1" });
    const address = world.app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  async function token(): Promise<string> {
    const { app, adminToken, templateId } = world;
    const staff = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: { templateId, name: `Early ${Math.random().toString(36).slice(2)}`, verification: "open" },
    });
    const { campaign, link } = created.json();
    await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: staff });
    const opened = await app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1] ?? ""}/open`,
      payload: {},
    });
    const grant = opened.json();
    await app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: `Bearer pt.${grant.participantToken}` },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    return grant.participantToken as string;
  }

  /** Opens a call, starts the interview and returns every frame up to the end of the first speech. */
  async function firstExchange(): Promise<Record<string, unknown>[]> {
    const { WebSocket } = await import("ws");
    const socket: WsClient = new WebSocket(`ws://127.0.0.1:${port}/api/v1/p/session/live`, {
      headers: { authorization: `Bearer pt.${await token()}` },
    });
    const frames: Record<string, unknown>[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no speech_end; saw ${frames.map((f) => String(f.type)).join(",")}`));
      }, 15_000);
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === "ready") socket.send(JSON.stringify({ type: "start" }));
        if (frame.type === "speech_end" && frame.more === false) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    try {
      await done;
    } finally {
      socket.close();
    }
    return frames;
  }

  it("says the first sentence long before the reply has finished, and the same words as displayed", async () => {
    const speechBefore = model.requests.length;
    const frames = await firstExchange();

    const firstWord = frames.find((f) => f.type === "first_word") as { ms: number } | undefined;
    expect(firstWord).toBeDefined();
    // The whole reply takes about 2.2 s to stream at this rate, so a first word bounded by it
    // would land past 2.5 s with the synthesis; the target is 1.5 s.
    expect(firstWord?.ms).toBeLessThan(1500);

    // Two segments, one reply: the first promises more, the last closes it.
    const ends = frames.filter((f) => f.type === "speech_end");
    expect(ends.map((f) => f.more)).toEqual([true, false]);
    expect(frames.filter((f) => f.type === "speech_start")).toHaveLength(2);

    // What was synthesized, in order, is the displayed message and nothing else.
    const spoken = (model.requests.slice(speechBefore) as { input?: string }[])
      .filter((r) => typeof r.input === "string")
      .map((r) => r.input!);
    expect(spoken.length).toBe(2);
    expect(spoken.join(" ")).toBe(MESSAGE);
    const turn = frames.find((f) => f.type === "turn") as { message: { content: string } } | undefined;
    expect(turn?.message.content).toBe(MESSAGE);
    // The first segment was on its way before the turn (metadata) had been settled.
    expect(frames.findIndex((f) => f.type === "first_word")).toBeLessThan(
      frames.findIndex((f) => f.type === "turn"),
    );
  });

  it("keeps the first word under 1.5 s at the 95th percentile over repeated openings", async () => {
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      const frames = await firstExchange();
      times.push((frames.find((f) => f.type === "first_word") as { ms: number }).ms);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] ?? Infinity;
    expect(p95).toBeLessThanOrEqual(1500);
  }, 60_000);
});

/**
 * The same measurement against the drill's own provider (D-251) with the drill's settings: 400 ms
 * to the first byte and 250 characters a second for the model, 250 ms to the first audio byte. The
 * full-stack drill's record had p95 1.76 s here before the change (finding F1).
 */
describeDb("voice: first word against the fake provider at 250 characters a second", () => {
  let world: TestWorld;
  let fake: FakeProvider;
  let port = 0;

  beforeAll(async () => {
    fake = await startFakeProvider({
      behaviour: { latencyMs: 400, jitterMs: 100, charsPerSecond: 250, ttsFirstByteMs: 250 },
      env: {},
    });
    world = await testWorld(fake.url);
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: {
        authorization: `Bearer ${world.operatorToken}`,
        "x-company-id": world.companyId,
        "content-type": "application/json",
      },
      payload: { scope: "tenant", values: { "features.realtimeVoice": true } },
    });
    await world.db.setting.create({
      data: {
        scope: "tenant",
        scopeId: world.companyId,
        companyId: world.companyId,
        key: "ceiling.maxActiveCampaigns",
        value: 0,
      },
    });
    const provider = await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } });
    await world.db.route.create({
      data: {
        companyId: world.companyId,
        purpose: "tts",
        providerId: provider.id,
        model: "fake-voice",
        maxOutputTokens: 800,
      },
    });
    await world.app.listen({ port: 0, host: "127.0.0.1" });
    const address = world.app.server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });
  afterAll(async () => {
    await world.close();
    await fake.close();
  });

  async function openedToken(): Promise<string> {
    const { app, adminToken, templateId } = world;
    const staff = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: { templateId, name: `Fake ${Math.random().toString(36).slice(2)}`, verification: "open" },
    });
    const { campaign, link } = created.json();
    await app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: staff });
    const opened = await app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1] ?? ""}/open`,
      payload: {},
    });
    const grant = opened.json();
    await app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: `Bearer pt.${grant.participantToken}` },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    return grant.participantToken as string;
  }

  async function firstWordMs(): Promise<number> {
    const { WebSocket } = await import("ws");
    const socket: WsClient = new WebSocket(`ws://127.0.0.1:${port}/api/v1/p/session/live`, {
      headers: { authorization: `Bearer pt.${await openedToken()}` },
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("no first_word"));
        }, 20_000);
        socket.on("message", (data: Buffer, isBinary: boolean) => {
          if (isBinary) return;
          const frame = JSON.parse(data.toString("utf8")) as { type: string; ms?: number };
          if (frame.type === "ready") socket.send(JSON.stringify({ type: "start" }));
          if (frame.type === "first_word") {
            clearTimeout(timer);
            resolve(frame.ms ?? Infinity);
          }
        });
      });
    } finally {
      socket.close();
    }
  }

  it("p95 of the opening question's first word is at most 1.5 s", async () => {
    const times: number[] = [];
    for (let i = 0; i < 10; i++) times.push(await firstWordMs());
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Infinity;
    console.info(`first word with the fake provider at 250 chars/s: ${times.join(", ")} ms, p95 ${p95} ms`);
    expect(p95).toBeLessThanOrEqual(1500);
  }, 90_000);
});

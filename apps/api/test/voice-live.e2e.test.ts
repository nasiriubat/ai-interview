import type { Server } from "node:http";
import { describeDb } from "@aidp/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket as WsClient } from "ws";
import {
  fakeModelServer,
  testWorld,
  TURN_MARKER,
  type FakeRealtime,
  type RealtimeLog,
  type TestWorld,
} from "./helpers.js";

const suite = describeDb;

/**
 * The live voice cascade over a real WebSocket (FR-30a).
 *
 * `app.inject` cannot upgrade a connection, so the app is listened on a port and spoken to with a
 * real client. That is the point: the upgrade, the cookie, the binary frames and the close codes
 * are the parts most likely to be wrong, and none of them exist in an injected request.
 */
suite("live voice", () => {
  let world: TestWorld;
  let model: { server: Server; url: string; requests: unknown[]; realtime: RealtimeLog };
  let realtime: FakeRealtime = {
    kind: "transcript",
    text: "We copy every figure into the spreadsheet by hand.",
  };
  let port = 0;
  let transcript: { text: string; duration?: number } | Error = {
    text: "We type everything twice, once in the patient system and once in the sheet.",
  };

  const reply = `And how long does that take?\n${TURN_MARKER}\n${JSON.stringify({
    areaKey: "daily",
    voiceShortForm: "How long does that take?",
  })}`;

  beforeAll(async () => {
    model = await fakeModelServer(
      () => reply,
      undefined,
      () => transcript,
      () => realtime,
    );
    world = await testWorld(model.url);
    // Live voice ships off (`features.realtimeVoice` defaults to false), because it costs money
    // per second and needs two model routes a tenant may not have. Turning it on is the tenant's
    // decision, so the suite makes it explicitly.
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: { authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" },
      payload: { scope: "tenant", values: { "features.realtimeVoice": true } },
    });
    // Every call here opens its own campaign; the platform's default of twenty is for tenants,
    // not for a suite that is about the voice path.
    await world.db.setting.create({
      data: {
        scope: "tenant",
        scopeId: world.companyId,
        companyId: world.companyId,
        key: "ceiling.maxActiveCampaigns",
        value: 0,
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

  /** A participant token for a fresh open session, with the session id for assertions. */
  async function participantSession(): Promise<{ token: string; sessionId: string }> {
    const { app, adminToken, templateId } = world;
    const staff = { authorization: `Bearer ${adminToken}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: { templateId, name: `Live ${Math.random().toString(36).slice(2)}`, verification: "open" },
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
    return { token: grant.participantToken, sessionId: grant.sessionId };
  }

  /** Just the token, for the tests that do not assert on stored rows. */
  const participantToken = async (): Promise<string> => (await participantSession()).token;

  interface Client {
    socket: WsClient;
    json: Record<string, unknown>[];
    binary: Buffer[];
    /**
     * Resolves when a frame of this type arrives, or rejects after a timeout.
     *
     * `where` matters more than it looks: several frame types occur repeatedly in one call, and a
     * bare type match resolves on the assistant's caption when the test meant the participant's.
     */
    waitFor: (
      type: string,
      where?: (frame: Record<string, unknown>) => boolean,
      ms?: number,
    ) => Promise<Record<string, unknown>>;
    send: (payload: unknown) => void;
    /** Resolves once at least `n` frames of this type have arrived. */
    waitForCount: (type: string, n: number, ms?: number) => Promise<Record<string, unknown>[]>;
    close: () => void;
  }

  async function connect(token?: string): Promise<Client> {
    const { WebSocket } = await import("ws");
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/p/session/live`, {
      headers: token ? { authorization: `Bearer pt.${token}` } : {},
    });
    const json: Record<string, unknown>[] = [];
    const binary: Buffer[] = [];
    const waiters: {
      type: string;
      where: (frame: Record<string, unknown>) => boolean;
      resolve: (v: Record<string, unknown>) => void;
    }[] = [];

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        binary.push(data);
        return;
      }
      const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      json.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w && w.type === frame.type && w.where(frame)) {
          waiters.splice(i, 1);
          w.resolve(frame);
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        resolve();
      });
      socket.once("error", reject);
      socket.once("close", () => {
        resolve();
      }); // a refused socket closes without opening
    });

    return {
      socket,
      json,
      binary,
      waitFor: (type, where = () => true, ms = 8000) =>
        new Promise((resolve, reject) => {
          const found = json.find((f) => f.type === type && where(f));
          if (found) {
            resolve(found);
            return;
          }
          const timer = setTimeout(() => {
            reject(new Error(`no ${type} frame within ${ms}ms`));
          }, ms);
          waiters.push({
            type,
            where,
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
          });
        }),
      send: (payload) => {
        socket.send(JSON.stringify(payload));
      },
      waitForCount: async (type, n, ms = 8000) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const found = json.filter((f) => f.type === type);
          if (found.length >= n) return found;
          if (Date.now() > deadline) throw new Error(`only ${found.length} ${type} frames within ${ms}ms`);
          await new Promise((r) => setTimeout(r, 25));
        }
      },
      close: () => {
        socket.close();
      },
    };
  }

  it("refuses a socket with no participant session", async () => {
    const client = await connect();

    // Either refused at the upgrade or closed immediately after; both are a refusal.
    await new Promise((r) => setTimeout(r, 300));
    expect(client.socket.readyState).not.toBe(client.socket.OPEN);
  });

  it("opens, says what it can do, and speaks the first question", async () => {
    const token = await participantToken();
    const client = await connect(token);

    const ready = await client.waitFor("ready");
    expect(ready).toMatchObject({ captions: true, bargeIn: true });

    client.send({ type: "start" });
    const turn = await client.waitFor("turn");
    expect((turn as { message: { content: string } }).message.content).toContain("how long");

    // The spoken form the model supplied, not the written one: that is what gets synthesized.
    const caption = await client.waitFor("caption");
    expect(caption).toMatchObject({ role: "assistant" });

    client.close();
  });

  it("transcribes an utterance, captions it, and answers it as a normal turn", async () => {
    const token = await participantToken();
    const client = await connect(token);
    await client.waitFor("ready");
    client.send({ type: "start" });
    await client.waitFor("turn");

    client.socket.send(Buffer.from("fake opus bytes"));
    client.send({ type: "utterance", durationMs: 4200 });

    // Specifically the participant's caption: the assistant's is already in the log from `start`.
    const heard = await client.waitFor("caption", (f) => f.role === "user");

    expect(heard.text).toContain("everything twice");
    // And the interviewer answered it, as a normal turn on the same session: the opening question
    // and the reply to what was said.
    const turns = await client.waitForCount("turn", 2);
    expect(turns).toHaveLength(2);

    client.close();
  });

  it("reads the template's own voice settings, not the tenant's alone (D-229)", async () => {
    // Captions are on for the tenant by default; this interview's template turns them off.
    const row = await world.db.setting.create({
      data: {
        scope: "template",
        scopeId: world.templateId,
        companyId: world.companyId,
        key: "voice.captions",
        value: false,
      },
    });
    try {
      const client = await connect(await participantToken());
      const ready = await client.waitFor("ready");
      expect(ready).toMatchObject({ captions: false, bargeIn: true });
      client.close();
    } finally {
      await world.db.setting.delete({ where: { id: row.id } });
    }
  });

  it("refuses a call once the tenant's voice minutes are used up, and points at typing (D-229)", async () => {
    const provider = await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } });
    const booked = await world.db.llmCall.create({
      data: {
        companyId: world.companyId,
        purpose: "stt_stream",
        providerId: provider.id,
        model: "fake-model",
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 1,
        status: "ok",
        costCents: 0,
        audioSeconds: 600,
      },
    });
    const ceiling = await world.db.setting.create({
      data: {
        scope: "tenant",
        scopeId: world.companyId,
        companyId: world.companyId,
        key: "ceiling.voiceMinutes",
        value: 5,
      },
    });
    try {
      const client = await connect(await participantToken());
      const frame = await client.waitFor("unavailable");
      expect(frame).toMatchObject({ reason: "limit", fallback: "text" });
      await new Promise((r) => setTimeout(r, 100));
      expect(client.socket.readyState).not.toBe(client.socket.OPEN);
      expect(world.alerts.ofKind("ceiling.reached").some((a) => a.key.includes("voiceMinutes"))).toBe(true);
    } finally {
      await world.db.setting.delete({ where: { id: ceiling.id } });
      await world.db.llmCall.delete({ where: { id: booked.id } });
    }
  });

  it("says it heard nothing rather than answering silence", async () => {
    const token = await participantToken();
    const previous = transcript;
    transcript = { text: "   " };
    const client = await connect(token);
    await client.waitFor("ready");

    client.socket.send(Buffer.from("x"));
    client.send({ type: "utterance" });

    const frame = await client.waitFor("not_heard");
    expect(frame).toBeDefined();
    transcript = previous;
    client.close();
  });

  it("stops speaking at once when the participant talks over it", async () => {
    const token = await participantToken();
    const client = await connect(token);
    await client.waitFor("ready");
    client.send({ type: "start" });
    await client.waitFor("turn");

    client.send({ type: "barge" });

    const end = await client.waitFor("speech_end");
    expect(end).toMatchObject({ interrupted: true });
    client.close();
  });

  it("falls back to captions rather than failing when no speech model is configured", async () => {
    // The test world configures `transcription` but not `tts`, which is exactly the common case:
    // a tenant with a transcription model and no voice. The interview must still work.
    const token = await participantToken();
    const client = await connect(token);
    await client.waitFor("ready");
    client.send({ type: "start" });

    const frame = await client.waitFor("unavailable");
    expect(frame).toMatchObject({ reason: "no_tts_route", fallback: "captions" });
    // And the turn still happened.
    expect(client.json.some((f) => f.type === "turn")).toBe(true);
    client.close();
  });

  it("ignores a frame it does not understand instead of dropping the call", async () => {
    const token = await participantToken();
    const client = await connect(token);
    await client.waitFor("ready");

    client.socket.send("not json at all");
    client.send({ type: "nonsense" });
    client.send({ type: "start" });

    await client.waitFor("turn");
    expect(client.socket.readyState).toBe(client.socket.OPEN);
    client.close();
  });

  it("records the voice signals the spec asks to trace", async () => {
    const { token, sessionId } = await participantSession();
    const client = await connect(token);
    await client.waitFor("ready");
    client.send({ type: "start" });
    await client.waitFor("turn");
    client.send({ type: "barge" });
    await client.waitFor("speech_end");
    client.close();

    // Written on close, so poll rather than sleep a fixed amount. Scoped to this session: other
    // tests in this file close sockets too, and the newest row globally is not necessarily ours.
    let payload: { turns: number; interruptions: number; avgFirstWordMs: number | null } | undefined;
    for (let i = 0; i < 40 && !payload; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const row = await world.db.sessionEvent.findFirst({ where: { sessionId, type: "voice.live" } });
      payload = row?.payload as typeof payload;
    }

    expect(payload).toBeDefined();
    expect(payload?.turns).toBeGreaterThan(0);
    expect(payload?.interruptions).toBeGreaterThan(0);
  });

  it("refuses the socket when the tenant has not turned live voice on", async () => {
    const admin = { authorization: `Bearer ${world.adminToken}`, "content-type": "application/json" };
    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: admin,
      payload: { scope: "tenant", values: { "features.realtimeVoice": false } },
    });
    const token = await participantToken();

    const client = await connect(token);
    const frame = await client.waitFor("unavailable");

    // Told why, and pointed at the rung below, rather than just dropped.
    expect(frame).toMatchObject({ reason: "disabled", fallback: "recorded" });
    client.close();

    await world.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: admin,
      payload: { scope: "tenant", values: { "features.realtimeVoice": true } },
    });
  });

  it("reads the question already on screen without asking a new one", async () => {
    // Someone who switches to voice part-way through arrives at a question that was asked in text
    // and never spoken. Taking a turn would ask a second question before they answered the first.
    const { token, sessionId } = await participantSession();
    const first = await connect(token);
    await first.waitFor("ready");
    first.send({ type: "start" });
    await first.waitFor("turn");
    first.close();
    const before = await world.db.message.count({ where: { sessionId } });

    const client = await connect(token);
    await client.waitFor("ready");
    client.send({ type: "speak_last" });

    // It tries to speak, and says it cannot because this world has no tts route — which is the
    // proof it got as far as synthesis rather than running the engine.
    const frame = await client.waitFor("unavailable");
    expect(frame).toMatchObject({ reason: "no_tts_route" });
    // And crucially: no new turn, and nothing new written.
    expect(client.json.some((f) => f.type === "turn")).toBe(false);
    expect(await world.db.message.count({ where: { sessionId } })).toBe(before);
    client.close();
  });

  it("opens the interview when asked to repeat a question that was never asked", async () => {
    const token = await participantToken();
    const client = await connect(token);
    await client.waitFor("ready");

    client.send({ type: "speak_last" });

    // Nothing to repeat, so it asks the first question rather than sitting silent.
    const turn = await client.waitFor("turn");
    expect(turn).toBeDefined();
    client.close();
  });

  it("points at the record button when the route is Whisper on this server, which reads WAV only", async () => {
    // Live voice streams WebM; the on-server Whisper cannot read it (D-75). Recorded voice converts
    // to WAV in the browser first, so it works there, and typing would give up a working voice.
    const route = await world.db.route.findFirstOrThrow({
      where: { companyId: world.companyId, purpose: "transcription" },
    });
    const local = await world.db.provider.create({
      data: { companyId: null, kind: "local", name: "On this server (test)", apiKeyEnc: "", headers: {} },
    });
    await world.db.route.update({
      where: { id: route.id },
      data: { providerId: local.id, model: "onnx-community/whisper-small" },
    });
    try {
      const token = await participantToken();
      const client = await connect(token);
      await client.waitFor("ready");
      client.socket.send(Buffer.from("webm bytes"));
      client.send({ type: "utterance" });

      const frame = await client.waitFor("unavailable", (f) => f.reason === "transcription_needs_wav");

      expect(frame).toMatchObject({ fallback: "recorded" });
      client.close();
    } finally {
      await world.db.route.update({
        where: { id: route.id },
        data: { providerId: route.providerId, model: route.model },
      });
      await world.db.llmCall.deleteMany({ where: { providerId: local.id } });
      await world.db.provider.delete({ where: { id: local.id } });
    }
  });

  it("points at typing, not the record button, when there is no transcription route at all", async () => {
    // Recorded voice transcribes through the same route. Sending someone to the record button when
    // that route does not exist sends them at the one thing guaranteed to fail identically.
    const route = await world.db.route.findFirstOrThrow({
      where: { companyId: world.companyId, purpose: "transcription" },
    });
    await world.db.route.delete({ where: { id: route.id } });
    try {
      const token = await participantToken();
      const client = await connect(token);
      await client.waitFor("ready");
      client.socket.send(Buffer.from("some audio"));
      client.send({ type: "utterance" });

      const frame = await client.waitFor("unavailable", (f) => f.reason === "no_transcription_route");

      expect(frame).toMatchObject({ fallback: "text" });
      client.close();
    } finally {
      await world.db.route.create({
        data: {
          companyId: route.companyId,
          purpose: route.purpose,
          providerId: route.providerId,
          model: route.model,
          maxOutputTokens: route.maxOutputTokens,
        },
      });
    }
  });
  /**
   * Streaming captions (FR-30a, D-77): with an `stt_stream` route the browser sends PCM16 as it
   * captures it, the provider's realtime socket transcribes while the participant talks, and the
   * final transcript takes the turn exactly as a transcribed utterance does.
   */
  describe("with streaming transcription", () => {
    let routeId = "";
    /** 100 ms of 24 kHz PCM16 silence: the content is irrelevant to the fake, the format is not. */
    const pcm = (): Buffer => Buffer.alloc(4800);

    beforeAll(async () => {
      const provider = await world.db.route.findFirstOrThrow({
        where: { companyId: world.companyId, purpose: "interview_turn" },
      });
      const route = await world.db.route.create({
        data: {
          companyId: world.companyId,
          purpose: "stt_stream",
          providerId: provider.providerId,
          model: "gpt-live-transcribe",
          maxOutputTokens: 0,
        },
      });
      routeId = route.id;
    });
    afterAll(async () => {
      await world.db.route.deleteMany({ where: { id: routeId } });
    });

    it("announces stream mode and configures a 24 kHz transcription session", async () => {
      realtime = { kind: "transcript", text: "We copy every figure into the spreadsheet by hand." };
      const before = model.realtime.sessionUpdates.length;
      const client = await connect(await participantToken());

      const ready = await client.waitFor("ready");

      expect(ready).toMatchObject({ mode: "stream", sampleRate: 24000 });
      const update = model.realtime.sessionUpdates[before] as {
        type: string;
        audio: { input: { format: unknown; transcription: { model: string }; turn_detection: unknown } };
      };
      expect(update.type).toBe("transcription");
      expect(update.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
      expect(update.audio.input.transcription.model).toBe("gpt-live-transcribe");
      expect(update.audio.input.turn_detection).toMatchObject({
        type: "server_vad",
        silence_duration_ms: 700,
      });
      expect(model.realtime.connections.at(-1)).toMatchObject({
        url: "/v1/realtime?intent=transcription",
        authorization: "Bearer k",
      });
      client.close();
    });

    it("captions while the participant talks, then answers the final transcript as a turn", async () => {
      realtime = { kind: "transcript", text: "We copy every figure into the spreadsheet by hand." };
      const { token, sessionId } = await participantSession();
      const client = await connect(token);
      await client.waitFor("ready");
      client.send({ type: "start" });
      await client.waitFor("turn");

      client.socket.send(pcm());

      const partials = await client.waitForCount("caption_partial", 2);
      // Growing text, not deltas: each partial is the whole utterance so far.
      expect(partials[0]?.text).toBe("We copy every figure into");
      expect(partials[1]?.text).toBe("We copy every figure into the spreadsheet by hand.");
      const final = await client.waitFor("caption_final");
      expect(final).toMatchObject({
        role: "user",
        text: "We copy every figure into the spreadsheet by hand.",
      });
      // Answered on the same session as a normal voice turn: the opening question and the reply.
      await client.waitForCount("turn", 2);
      const answer = await world.db.message.findFirst({
        where: { sessionId, role: "user" },
        orderBy: { seq: "desc" },
      });
      expect(answer?.content).toBe("We copy every figure into the spreadsheet by hand.");
      // Metered through ModelCaller like every other call.
      const rows = await world.db.llmCall.count({
        where: { sessionId, purpose: "stt_stream", status: "ok" },
      });
      expect(rows).toBeGreaterThan(0);
      client.close();
    });

    it("forwards the provider's speech events, which also serve as barge-in", async () => {
      realtime = { kind: "transcript", text: "Yes." };
      const client = await connect(await participantToken());
      await client.waitFor("ready");

      client.socket.send(pcm());

      await client.waitFor("speech_started");
      await client.waitFor("speech_stopped");
      client.close();
    });

    it("traces time to first caption with the other voice signals", async () => {
      realtime = { kind: "transcript", text: "About an hour a day." };
      const { token, sessionId } = await participantSession();
      const client = await connect(token);
      await client.waitFor("ready");
      client.send({ type: "start" });
      await client.waitFor("turn");
      client.socket.send(pcm());
      await client.waitForCount("turn", 2);
      client.close();

      let payload: { avgFirstPartialMs: number | null; mode: string } | undefined;
      for (let i = 0; i < 40 && !payload; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const row = await world.db.sessionEvent.findFirst({ where: { sessionId, type: "voice.live" } });
        payload = row?.payload as typeof payload;
      }
      expect(payload?.mode).toBe("stream");
      expect(typeof payload?.avgFirstPartialMs).toBe("number");
    });

    it("falls back to per-utterance transcription when the provider refuses the session", async () => {
      realtime = { kind: "refuse" };
      const client = await connect(await participantToken());

      const ready = await client.waitFor("ready");

      expect(ready).toMatchObject({ mode: "utterance" });
      // And the rung below works: a recorded utterance is transcribed through `transcription`.
      client.socket.send(Buffer.from("fake opus bytes"));
      client.send({ type: "utterance" });
      const heard = await client.waitFor("caption", (f) => f.role === "user");
      expect(heard.text).toContain("everything twice");
      client.close();
    });

    it("drops to per-utterance mid-call when the stream dies and a transcription route exists", async () => {
      realtime = { kind: "drop" };
      const client = await connect(await participantToken());
      await client.waitFor("ready", (f) => f.mode === "stream");

      client.socket.send(pcm());

      const mode = await client.waitFor("mode");
      expect(mode).toMatchObject({ mode: "utterance", reason: "stt_stream_failed" });
      // PCM still in flight is dropped until the browser says it switched capture.
      client.socket.send(pcm());
      client.send({ type: "capture", mode: "utterance" });
      client.socket.send(Buffer.from("fake opus bytes"));
      client.send({ type: "utterance" });
      const heard = await client.waitFor("caption", (f) => f.role === "user");
      expect(heard.text).toContain("everything twice");
      client.close();
    });

    it("points at typing when the stream dies and there is no transcription route to drop to", async () => {
      realtime = { kind: "drop" };
      const route = await world.db.route.findFirstOrThrow({
        where: { companyId: world.companyId, purpose: "transcription" },
      });
      await world.db.route.delete({ where: { id: route.id } });
      try {
        const client = await connect(await participantToken());
        await client.waitFor("ready", (f) => f.mode === "stream");

        client.socket.send(pcm());

        const frame = await client.waitFor("unavailable");
        expect(frame).toMatchObject({ reason: "stt_stream_failed", fallback: "text" });
        client.close();
      } finally {
        await world.db.route.create({
          data: {
            companyId: route.companyId,
            purpose: route.purpose,
            providerId: route.providerId,
            model: route.model,
            maxOutputTokens: route.maxOutputTokens,
          },
        });
      }
    });
  });
});

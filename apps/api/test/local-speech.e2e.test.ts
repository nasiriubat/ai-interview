import { LOCAL_WHISPER_MODELS, SpeechRunner } from "@aidp/ai";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSpeechModelToWarm, warmLocalSpeech } from "../src/lib/local-speech.js";
import {
  fakeModelServer,
  FakeSpeechEngine,
  parseSse,
  testWorld,
  TURN_MARKER,
  type TestWorld,
} from "./helpers.js";

const suite = process.env.DATABASE_URL ? describe : describe.skip;

/** One second of 16 kHz mono PCM WAV carrying a tone, which is what the browser uploads (D-75). */
function wavTone(seconds = 1): Buffer {
  const rate = 16_000;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 300 * i) / rate)), 44 + i * 2);
  return buf;
}

/**
 * Recorded voice with no API key (D-75, FR-30): a platform `local` provider, a route to it, and a
 * WAV upload. The engine is the in-memory fake every test world carries, so nothing here loads a
 * model; `packages/ai` tests the runner and the WAV reader, and this proves the wiring.
 */
suite("recorded voice transcribed on this server", () => {
  let world: TestWorld;
  let model: Awaited<ReturnType<typeof fakeModelServer>>;
  let localId = "";
  const reply = `Thanks. What happens next?\n${TURN_MARKER}\n${JSON.stringify({ areaKey: "daily" })}`;

  beforeAll(async () => {
    model = await fakeModelServer(() => reply);
    world = await testWorld(model.url);
  });
  afterAll(async () => {
    await world.db.route.updateMany({
      where: { companyId: world.companyId, purpose: "transcription" },
      data: {
        providerId: (await world.db.provider.findFirstOrThrow({ where: { companyId: world.companyId } })).id,
      },
    });
    if (localId) {
      await world.db.llmCall.deleteMany({ where: { providerId: localId } });
      await world.db.modelPrice.deleteMany({ where: { providerId: localId } });
      await world.db.provider.deleteMany({ where: { id: localId } });
    }
    await world.close();
    model.server.close();
  });

  const operator = (): Record<string, string> => ({ authorization: `Bearer ${world.operatorToken}` });
  const admin = (): Record<string, string> => ({ authorization: `Bearer ${world.adminToken}` });

  function multipart(file: { name: string; type: string; body: Buffer }): {
    payload: Buffer;
    headers: Record<string, string>;
  } {
    const boundary = `----test${Math.random().toString(36).slice(2)}`;
    return {
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
            `Content-Type: ${file.type}\r\n\r\n`,
        ),
        file.body,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    };
  }

  async function participant(): Promise<string> {
    const staff = admin();
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/campaigns",
      headers: staff,
      payload: {
        templateId: world.templateId,
        name: `Local ${Math.random().toString(36).slice(2)}`,
        verification: "open",
      },
    });
    const { campaign, link } = created.json();
    await world.app.inject({ method: "POST", url: `/api/v1/campaigns/${campaign.id}/open`, headers: staff });
    const opened = await world.app.inject({
      method: "POST",
      url: `/api/v1/p/${link.url.split("/p/")[1] ?? ""}/open`,
      payload: {},
    });
    const token = `Bearer pt.${opened.json().participantToken}`;
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/consent",
      headers: { authorization: token },
      payload: { consentVersion: "v1", participationChoice: "anonymous" },
    });
    await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/turns",
      headers: { authorization: token },
    });
    return token;
  }

  it("lets the operator add the on-server provider without a key, and keeps it a platform resource", async () => {
    const created = await world.app.inject({
      method: "POST",
      url: "/api/v1/operator/providers",
      headers: operator(),
      payload: { kind: "local", name: "On this server (Whisper)" },
    });
    expect(created.statusCode).toBe(201);
    const provider = created.json().provider;
    expect(provider).toMatchObject({ kind: "local", hasKey: false });
    localId = provider.id;

    // A tenant does not get its own copy: it would spend the operator's CPU and memory.
    const tenant = await world.app.inject({
      method: "POST",
      url: "/api/v1/providers",
      headers: admin(),
      payload: { kind: "local", name: "mine" },
    });
    expect(tenant.statusCode).toBe(403);

    // Its catalogue is the allow-list, all free.
    const models = await world.app.inject({
      method: "GET",
      url: `/api/v1/operator/providers/${localId}/models`,
      headers: operator(),
    });
    expect(models.json().models.map((m: { id: string }) => m.id)).toEqual(
      LOCAL_WHISPER_MODELS.map((m) => m.id),
    );
  });

  it("tests the on-server provider by transcribing, not by chatting", async () => {
    const res = await world.app.inject({
      method: "POST",
      url: `/api/v1/operator/providers/${localId}/test`,
      headers: operator(),
      payload: { model: "onnx-community/whisper-small" },
    });
    expect(res.json()).toMatchObject({ ok: true, model: "onnx-community/whisper-small", costCents: 0 });
  });

  it("transcribes a WAV recording into a turn, guessing among the interview's languages", async () => {
    await world.db.route.updateMany({
      where: { companyId: world.companyId, purpose: "transcription" },
      data: { providerId: localId, model: "onnx-community/whisper-small" },
    });
    const token = await participant();
    const before = world.speech.calls.length;
    const body = multipart({ name: "recording.wav", type: "audio/wav", body: wavTone(2) });
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/voice-turns",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(200);
    const heard = parseSse(res.body).find((e) => e.event === "transcript");
    expect(heard?.data).toMatchObject({ text: world.speech.text, durationMs: 2000 });

    const call = world.speech.calls[before];
    expect(call).toMatchObject({ model: "onnx-community/whisper-small", seconds: 2 });
    expect(call?.hint.candidates).toEqual(expect.arrayContaining(["fi", "en"]));

    const ledger = await world.db.llmCall.findFirstOrThrow({
      where: { companyId: world.companyId, purpose: "transcription" },
      orderBy: { createdAt: "desc" },
    });
    expect(ledger).toMatchObject({ providerId: localId, costCents: 0, status: "ok" });
  });

  it("tells the participant to type when the browser could not convert its recording", async () => {
    const token = await participant();
    const body = multipart({ name: "recording.webm", type: "audio/webm", body: Buffer.from("not wav") });
    const res = await world.app.inject({
      method: "POST",
      url: "/api/v1/p/session/voice-turns",
      headers: { authorization: token, ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/type your answer/);
  });

  it("warms up the model a route names, and reports it on the readiness endpoint", async () => {
    expect(LOCAL_WHISPER_MODELS.map((m) => m.id)).toContain(await localSpeechModelToWarm(world.db));

    const engine = new FakeSpeechEngine();
    const runner = new SpeechRunner(engine);
    await warmLocalSpeech(world.db, pino({ level: "silent" }), runner);
    expect(runner.status().state).toBe("ready");

    const ready = await world.app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(ready.statusCode).toBe(200);
    // The world's own runner loaded whisper-small for the recording above.
    expect(ready.json().speech).toEqual({ model: "onnx-community/whisper-small", state: "ready", queued: 0 });
  });
});

import type { ProviderConfig, Route } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelCaller } from "../../src/callModel.js";
import { BudgetGuard, StaticBudgetLimits } from "../../src/cost/budget.js";
import { InMemoryLedger } from "../../src/cost/ledger.js";
import { PriceTable } from "../../src/cost/pricing.js";
import { SpeechRunner } from "../../src/providers/local-whisper/runner.js";
import { isSilent, LocalWhisperProvider, whisperLanguage } from "../../src/providers/local-whisper.js";
import { createProvider, ProviderRegistry } from "../../src/providers/registry.js";
import { type ProviderError, UnsupportedAudioError } from "../../src/providers/types.js";
import { FakeEngine, tone, wav } from "./fixtures.js";

const SMALL = "onnx-community/whisper-small";

function setup() {
  const engine = new FakeEngine();
  const runner = new SpeechRunner(engine);
  const provider = new LocalWhisperProvider({ id: "local", runner });
  return { engine, provider };
}

const speech = (seconds = 2, rate = 16000): Uint8Array =>
  wav({ channels: [tone(seconds, rate)], sampleRate: rate, format: "pcm16" });

describe("LocalWhisperProvider (D-75, FR-30)", () => {
  it("transcribes WAV through the runner and reports the audio length", async () => {
    const { engine, provider } = setup();
    const res = await provider.transcribe(SMALL, { data: speech(2), mime: "audio/wav", filename: "r.wav" });
    expect(res.transcript).toEqual({ text: "heard", durationSeconds: 2 });
    expect(res.usage).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
    expect(engine.runs).toEqual([{ model: SMALL, seconds: 2, language: undefined }]);
  });

  it("hands Whisper 16 kHz whatever rate the WAV was recorded at", async () => {
    const { engine, provider } = setup();
    await provider.transcribe(SMALL, { data: speech(1, 48000), mime: "audio/wav", filename: "r.wav" });
    expect(engine.runs[0]?.seconds).toBe(1);
  });

  it("passes a language hint as an ISO code, and lets the model detect it otherwise", async () => {
    const { engine, provider } = setup();
    await provider.transcribe(SMALL, {
      data: speech(),
      mime: "audio/wav",
      filename: "r.wav",
      language: "fi-FI",
    });
    await provider.transcribe(SMALL, {
      data: speech(),
      mime: "audio/wav",
      filename: "r.wav",
      language: "en",
    });
    await provider.transcribe(SMALL, { data: speech(), mime: "audio/wav", filename: "r.wav" });
    expect(engine.runs.map((r) => r.language)).toEqual(["fi", "en", undefined]);
    expect(engine.runs.every((r) => r.candidates === undefined)).toBe(true);
    expect(whisperLanguage("Finnish language")).toBeUndefined();
    expect(whisperLanguage(" FI ")).toBe("fi");
  });

  it("narrows detection to the interview's likely languages when it is not told one", async () => {
    const { engine, provider } = setup();
    const data = speech();
    await provider.transcribe(SMALL, {
      data,
      mime: "audio/wav",
      filename: "r.wav",
      languages: ["fi-FI", "fi", "en", "??"],
    });
    await provider.transcribe(SMALL, {
      data,
      mime: "audio/wav",
      filename: "r.wav",
      language: "en",
      languages: ["fi"],
    });
    expect(engine.runs[0]).toMatchObject({ language: undefined, candidates: ["fi", "en"] });
    expect(engine.runs[1]).toEqual({ model: SMALL, seconds: 2, language: "en" });
  });

  it("refuses WebM with an unsupported error that says the browser should have converted it", async () => {
    const { engine, provider } = setup();
    const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
    const err = await provider
      .transcribe(SMALL, { data: webm, mime: "audio/webm", filename: "r.webm" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedAudioError);
    expect((err as ProviderError).code).toBe("unsupported");
    expect((err as ProviderError).message).toMatch(/browser should have converted/);
    expect(engine.runs).toHaveLength(0);
  });

  it("refuses a WAV it cannot read as unsupported audio", async () => {
    const { provider } = setup();
    const bytes = speech();
    new DataView(bytes.buffer).setUint16(34, 8, true); // 8-bit
    await expect(
      provider.transcribe(SMALL, { data: bytes, mime: "audio/wav", filename: "r.wav" }),
    ).rejects.toThrow(UnsupportedAudioError);
  });

  it("returns an empty transcript for silence without running the model", async () => {
    const { engine, provider } = setup();
    const quiet = wav({ channels: [tone(3, 16000, 0.001)], sampleRate: 16000, format: "pcm16" });
    const res = await provider.transcribe(SMALL, { data: quiet, mime: "audio/wav", filename: "r.wav" });
    expect(res.transcript).toEqual({ text: "", durationSeconds: 3 });
    expect(engine.runs).toHaveLength(0);
    expect(isSilent(tone(1, 16000, 0.05))).toBe(false);
  });

  it("refuses a model that is not on its list", async () => {
    const { provider } = setup();
    const err = await provider
      .transcribe("openai/whisper-large-v2", { data: speech(), mime: "audio/wav", filename: "r.wav" })
      .catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("bad_request");
  });

  it("lists its models at zero cost and does nothing but transcribe", async () => {
    const { provider } = setup();
    const models = await provider.listModels();
    expect(models.map((m) => m.id)).toEqual([
      "onnx-community/whisper-small",
      "onnx-community/whisper-base",
      "onnx-community/whisper-large-v3-turbo",
    ]);
    expect(models.every((m) => m.inputPerMtok === 0 && m.outputPerMtok === 0)).toBe(true);
    expect(provider.capabilities).toMatchObject({ transcription: true, speech: false, vision: false });
    await expect(
      provider.complete("m", { messages: [], maxOutputTokens: 1, cachePrefix: false }, z.string()),
    ).rejects.toMatchObject({ code: "unsupported" });
    const chat = provider.chat()[Symbol.asyncIterator]();
    await expect(chat.next()).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("keeping the native runtime out of everything but the speech thread", () => {
  it("imports transformers.js from thread.ts and nowhere else", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const root = new URL("../../src/", import.meta.url);
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts"));
    const importers: string[] = [];
    for (const f of files) {
      if ((await readFile(new URL(f, root), "utf8")).includes('import("@huggingface/transformers")'))
        importers.push(f);
    }
    expect(importers).toEqual(["providers/local-whisper/thread.ts"]);
    for (const f of files) {
      expect(await readFile(new URL(f, root), "utf8"), f).not.toMatch(/from "@huggingface\/transformers"/);
    }
  });
});

describe("the local provider behind ModelCaller", () => {
  const cfg: ProviderConfig = {
    id: "local",
    companyId: null,
    kind: "local",
    name: "On this server (Whisper)",
    apiKey: "",
    headers: {},
    enabled: true,
  };

  it("is built by the registry for kind local", () => {
    const p = createProvider(cfg, { speech: new SpeechRunner(new FakeEngine()) });
    expect(p).toBeInstanceOf(LocalWhisperProvider);
    expect(p.kind).toBe("local");
  });

  it("routes transcription to it and writes a free ledger row", async () => {
    const engine = new FakeEngine();
    const ledger = new InMemoryLedger();
    const route: Route = {
      companyId: null,
      purpose: "transcription",
      providerId: "local",
      model: SMALL,
      maxOutputTokens: 1,
      batchAllowed: false,
    };
    const prices = new PriceTable();
    prices.importFromModels("local", await new LocalWhisperProvider({ id: "local" }).listModels());
    const caller = new ModelCaller({
      routes: { resolve: async () => route },
      providerConfigs: { get: async () => cfg },
      registry: new ProviderRegistry({ speech: new SpeechRunner(engine) }),
      prices,
      ledger,
      budget: new BudgetGuard(
        new StaticBudgetLimits([{ scope: "tenant", scopeId: "c1", limitCents: 0, period: "month" }]),
        ledger,
      ),
    });
    const transcript = await caller.transcribe(
      { companyId: "c1", sessionId: "s1" },
      { data: speech(), mime: "audio/wav", filename: "r.wav" },
    );
    expect(transcript.text).toBe("heard");
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      purpose: "transcription",
      status: "ok",
      costCents: 0,
      model: SMALL,
    });
  });
});

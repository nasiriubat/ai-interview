import { describe, expect, it } from "vitest";
import {
  idleUnloadMs,
  SpeechRunner,
  localSpeechStatus,
  modelCacheDir,
} from "../../src/providers/local-whisper/runner.js";
import { ProviderError } from "../../src/providers/types.js";
import { deferred, FakeEngine } from "./fixtures.js";

const SMALL = "onnx-community/whisper-small";
const BASE = "onnx-community/whisper-base";
const second = (): Float32Array => new Float32Array(16000);

describe("SpeechRunner: one Whisper job at a time (D-75)", () => {
  it("loads the model once and shares it across requests", async () => {
    const engine = new FakeEngine();
    const runner = new SpeechRunner(engine);
    await runner.transcribe(SMALL, second(), { language: "fi" });
    await runner.transcribe(SMALL, second());
    expect(engine.loads).toEqual([{ model: SMALL, dtype: "q8" }]);
    expect(engine.runs.map((r) => r.language)).toEqual(["fi", undefined]);
    expect(runner.status()).toEqual({ model: SMALL, state: "ready", queued: 0 });
  });

  it("never runs two transcriptions at once, and keeps their order", async () => {
    const engine = new FakeEngine();
    const first = deferred<{ text: string }>();
    engine.holdRun.push(first);
    const runner = new SpeechRunner(engine);
    const order: string[] = [];
    const a = runner.transcribe(SMALL, second(), { language: "fi" }).then(() => order.push("a"));
    const b = runner.transcribe(SMALL, second(), { language: "en" }).then(() => order.push("b"));
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.runs).toHaveLength(1);
    expect(runner.status().queued).toBe(1);
    first.resolve({ text: "one" });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    expect(engine.maxRunning).toBe(1);
    expect(runner.status().queued).toBe(0);
  });

  it("swaps models rather than holding two in memory", async () => {
    const engine = new FakeEngine();
    const runner = new SpeechRunner(engine);
    await runner.transcribe(SMALL, second());
    await runner.transcribe(BASE, second());
    await runner.transcribe(BASE, second());
    expect(engine.loads.map((l) => l.model)).toEqual([SMALL, BASE]);
  });

  it("tells the participant the model is still downloading when the first load outlasts the wait", async () => {
    const engine = new FakeEngine();
    engine.holdLoad = deferred<undefined>();
    const runner = new SpeechRunner(engine, { startTimeoutMs: 20 });
    void runner.warmUp(SMALL);
    const err = await runner.transcribe(SMALL, second(), { language: "fi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("server");
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as ProviderError).message).toMatch(/still downloading/);
    expect(runner.status()).toMatchObject({ state: "downloading", progress: 0.5, queued: 0 });

    // The load carries on; the abandoned request never runs, and the next one does.
    engine.holdLoad.resolve(undefined);
    await runner.warmUp(SMALL);
    expect(engine.runs).toHaveLength(0);
    await expect(runner.transcribe(SMALL, second(), { language: "fi" })).resolves.toMatchObject({
      text: " heard ",
    });
  });

  it("stops a transcription that overruns, restarts the thread, and serves the next one", async () => {
    const engine = new FakeEngine();
    engine.holdRun.push(deferred());
    const runner = new SpeechRunner(engine, { runTimeoutMs: () => 20 });
    const err = await runner.transcribe(SMALL, second(), { language: "fi" }).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("server");
    expect((err as ProviderError).message).toMatch(/longer than/);
    expect(engine.resets).toBe(1);
    expect(runner.status().state).toBe("not_loaded");

    await expect(runner.transcribe(SMALL, second(), { language: "fi" })).resolves.toMatchObject({
      text: " heard ",
    });
    expect(engine.loads).toHaveLength(2); // reloaded after the reset
  });

  it("scales the run timeout with the length of the audio", async () => {
    const seen: number[] = [];
    const runner = new SpeechRunner(new FakeEngine(), {
      runTimeoutMs: (s) => {
        seen.push(s);
        return 1000;
      },
    });
    await runner.transcribe(SMALL, new Float32Array(16000 * 90));
    expect(seen).toEqual([90]);
  });

  it("reports a failed load, and tries again on the next request", async () => {
    const engine = new FakeEngine();
    engine.failLoad = new Error("getaddrinfo ENOTFOUND huggingface.co");
    const runner = new SpeechRunner(engine);
    await runner.warmUp(SMALL); // never throws, even offline
    expect(runner.status()).toMatchObject({ model: SMALL, state: "error", error: /ENOTFOUND/ });

    const err = await runner.transcribe(SMALL, second(), { language: "fi" }).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("network");
    expect(runner.status().queued).toBe(0);

    engine.failLoad = undefined;
    await expect(runner.transcribe(SMALL, second(), { language: "fi" })).resolves.toBeDefined();
    expect(engine.loads).toHaveLength(3);
  });

  it("refuses a model that is not on the list, without loading anything", async () => {
    const engine = new FakeEngine();
    const runner = new SpeechRunner(engine);
    const err = await runner.transcribe("someone/huge-model", second()).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("bad_request");
    expect(engine.loads).toHaveLength(0);
  });

  it("turns requests away once the queue is full", async () => {
    const engine = new FakeEngine();
    const hold = deferred<{ text: string }>();
    engine.holdRun.push(hold);
    const runner = new SpeechRunner(engine, { maxQueued: 2 });
    const running = runner.transcribe(SMALL, second());
    await new Promise((r) => setTimeout(r, 5));
    const queued = [runner.transcribe(SMALL, second()), runner.transcribe(SMALL, second())];
    const err = await runner.transcribe(SMALL, second()).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe("rate_limit");
    hold.resolve({ text: "x" });
    await Promise.all([running, ...queued]);
  });

  it("reports not_loaded for a process that never transcribed", () => {
    expect(localSpeechStatus()).toEqual({ model: null, state: "not_loaded", queued: 0 });
  });

  it("keeps models in MODEL_CACHE_DIR, or a user cache without it", () => {
    expect(modelCacheDir({ MODEL_CACHE_DIR: "/models" })).toBe("/models");
    expect(modelCacheDir({})).toMatch(/aidp-models$/);
  });
});

describe("SpeechRunner: releasing an idle model", () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("lets the model go after the idle period and loads it again for the next recording", async () => {
    const engine = new FakeEngine();
    const runner = new SpeechRunner(engine, { idleUnloadMs: 30 });
    await runner.transcribe(SMALL, second());
    expect(runner.status().state).toBe("ready");
    await wait(80);
    expect(engine.resets).toBe(1);
    expect(runner.status()).toEqual({ model: null, state: "not_loaded", queued: 0 });
    await runner.transcribe(SMALL, second());
    expect(engine.loads).toHaveLength(2);
  });

  it("keeps the model while recordings keep arriving inside the idle period", async () => {
    const engine = new FakeEngine();
    const runner = new SpeechRunner(engine, { idleUnloadMs: 60 });
    for (let i = 0; i < 4; i++) {
      await runner.transcribe(SMALL, second());
      await wait(25);
    }
    expect(engine.resets).toBe(0);
    expect(engine.loads).toHaveLength(1);
  });

  it("starts the idle clock after warming up, so an unused model does not sit in memory", async () => {
    const engine = new FakeEngine();
    const runner = new SpeechRunner(engine, { idleUnloadMs: 30 });
    await runner.warmUp(SMALL);
    await wait(80);
    expect(engine.resets).toBe(1);
  });

  it("never lets go with an idle period of 0", async () => {
    const engine = new FakeEngine();
    const runner = new SpeechRunner(engine, { idleUnloadMs: 0 });
    await runner.transcribe(SMALL, second());
    await wait(50);
    expect(engine.resets).toBe(0);
    expect(runner.status().state).toBe("ready");
  });

  it("reads the idle period from SPEECH_MODEL_IDLE_MINUTES, defaulting to ten minutes", () => {
    expect(idleUnloadMs({})).toBe(600_000);
    expect(idleUnloadMs({ SPEECH_MODEL_IDLE_MINUTES: "0" })).toBe(0);
    expect(idleUnloadMs({ SPEECH_MODEL_IDLE_MINUTES: "2.5" })).toBe(150_000);
    expect(idleUnloadMs({ SPEECH_MODEL_IDLE_MINUTES: "soon" })).toBe(600_000);
    expect(idleUnloadMs({ SPEECH_MODEL_IDLE_MINUTES: "-1" })).toBe(600_000);
  });
});

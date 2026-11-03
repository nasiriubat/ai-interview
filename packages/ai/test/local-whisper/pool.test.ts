import { describe, expect, it } from "vitest";
import { SpeechPool, SpeechRunner, speechWorkers } from "../../src/providers/local-whisper/runner.js";
import { deferred, FakeEngine } from "./fixtures.js";

const SMALL = "onnx-community/whisper-small";
const second = (): Float32Array => new Float32Array(16000);

describe("SpeechPool: engines side by side (D-494)", () => {
  it("runs two recordings at once on two engines, where one runner would queue the second", async () => {
    const a = new FakeEngine();
    const b = new FakeEngine();
    const held = deferred<{ text: string }>();
    a.holdRun.push(held);
    const pool = new SpeechPool([new SpeechRunner(a), new SpeechRunner(b)]);
    await pool.warmUp(SMALL);
    const first = pool.transcribe(SMALL, second());
    // The first engine is busy with a long answer; the next recording goes to the idle one.
    await new Promise((r) => setTimeout(r, 0));
    const secondDone = await pool.transcribe(SMALL, second(), { language: "fi" });
    expect(secondDone.text).toBe(" heard ");
    expect(b.runs).toHaveLength(1);
    held.resolve({ text: "long" });
    expect((await first).text).toBe("long");
    expect(a.runs).toHaveLength(1);
  });

  it("loads the model in every engine on warm-up and reports ready", async () => {
    const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine()];
    const pool = new SpeechPool(engines.map((e) => new SpeechRunner(e)));
    await pool.warmUp(SMALL);
    expect(engines.map((e) => e.loads.length)).toEqual([1, 1, 1]);
    expect(pool.status()).toEqual({ model: SMALL, state: "ready", queued: 0 });
  });

  it("reads SPEECH_WORKERS, defaulting to one and refusing nonsense", () => {
    expect(speechWorkers({})).toBe(1);
    expect(speechWorkers({ SPEECH_WORKERS: "2" })).toBe(2);
    expect(speechWorkers({ SPEECH_WORKERS: "0" })).toBe(1);
    expect(speechWorkers({ SPEECH_WORKERS: "lots" })).toBe(1);
  });
});

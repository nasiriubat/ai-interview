import { ProviderError, UnsupportedAudioError } from "@aidp/ai";
import { describe, expect, it } from "vitest";
import { AudioGate } from "../src/modules/participant/voice-live/audio-gate.js";
import { degradation, fallbackFor } from "../src/modules/participant/voice-live/degrade.js";
import { VoiceMetrics } from "../src/modules/participant/voice-live/metrics.js";
import { MAX_UTTERANCE_BYTES, parseClientFrame } from "../src/modules/participant/voice-live/protocol.js";
import { LiveState } from "../src/modules/participant/voice-live/state.js";

const frame = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

describe("live voice protocol", () => {
  it("parses the control frames the browser sends", () => {
    expect(parseClientFrame(frame({ type: "start" }))).toEqual({ type: "start" });
    expect(parseClientFrame(frame({ type: "utterance", durationMs: 1200 }))).toEqual({
      type: "utterance",
      durationMs: 1200,
    });
    expect(parseClientFrame(frame({ type: "capture", mode: "stream" }))).toEqual({
      type: "capture",
      mode: "stream",
    });
  });

  it("ignores anything malformed instead of throwing", () => {
    expect(parseClientFrame(Buffer.from("not json"))).toBeUndefined();
    expect(parseClientFrame(frame({ type: "nope" }))).toBeUndefined();
    expect(parseClientFrame(frame({ type: "utterance", durationMs: -1 }))).toBeUndefined();
    expect(parseClientFrame(frame({ type: "capture", mode: "telepathy" }))).toBeUndefined();
  });
});

describe("audio gate", () => {
  it("admits audio up to the ceiling and refuses the chunk that crosses it", () => {
    const gate = new AudioGate();
    expect(gate.admit(60, 100)).toBe(true);
    expect(gate.admit(40, 100)).toBe(true);
    expect(gate.admit(1, 100)).toBe(false);
    expect(gate.sessionBytes).toBe(101);
  });

  it("buffers an utterance, hands it over once, and starts empty again", () => {
    const gate = new AudioGate();
    gate.append(Buffer.from([1, 2]));
    gate.append(Buffer.from([3]));
    expect([...gate.take()]).toEqual([1, 2, 3]);
    expect(gate.take().byteLength).toBe(0);
  });

  it("drops the tail of an utterance past the per-utterance cap, keeping the head", () => {
    const gate = new AudioGate();
    gate.append(Buffer.alloc(MAX_UTTERANCE_BYTES - 1, 7));
    gate.append(Buffer.alloc(10, 9)); // would cross the cap: dropped
    expect(gate.take().byteLength).toBe(MAX_UTTERANCE_BYTES - 1);
  });

  it("restores a held recording as the utterance in progress", () => {
    const gate = new AudioGate();
    gate.restore(Buffer.from([4, 5]));
    expect([...gate.take()]).toEqual([4, 5]);
  });

  it("cuts a stray byte so PCM16 samples stay aligned", () => {
    expect(AudioGate.evenPcm(Buffer.from([1, 2, 3])).byteLength).toBe(2);
    expect(AudioGate.evenPcm(Buffer.from([1, 2, 3, 4])).byteLength).toBe(4);
  });
});

describe("live state", () => {
  it("derives the phase from what is happening, with closed terminal", () => {
    const s = new LiveState();
    expect(s.phase).toBe("listening");
    s.busy = true;
    expect(s.phase).toBe("thinking");
    s.speaking = new AbortController();
    expect(s.phase).toBe("speaking");
    s.close();
    expect(s.phase).toBe("closed");
    expect(s.speaking.signal.aborted).toBe(true);
  });

  it("holds only the most recent thing said mid-turn, and releases it once", () => {
    const s = new LiveState();
    s.hold({ kind: "text", text: "first" });
    s.hold({ kind: "text", text: "second" });
    expect(s.takeHeld()).toEqual({ kind: "text", text: "second" });
    expect(s.takeHeld()).toBeUndefined();
  });

  it("does not release a held utterance into a closed call", () => {
    const s = new LiveState();
    s.hold({ kind: "text", text: "late" });
    s.close();
    expect(s.takeHeld()).toBeUndefined();
  });

  it("closes the provider's transcription socket with the call", () => {
    const s = new LiveState();
    let closed = false;
    s.stt = {
      events: (async function* (): AsyncGenerator<never> {
        yield* [];
      })(),
      push: () => undefined,
      close: () => (closed = true),
    };
    s.close();
    expect(closed).toBe(true);
  });
});

describe("voice metrics", () => {
  it("writes nothing for a call that never took a turn", () => {
    expect(new VoiceMetrics().snapshot("utterance", 123)).toBeUndefined();
  });

  it("averages the first-word and first-partial samples, rounded, and null when there are none", () => {
    const m = new VoiceMetrics();
    m.turns = 2;
    m.interruptions = 1;
    m.firstWord(900);
    m.firstWord(1101);
    expect(m.snapshot("stream", 4096)).toEqual({
      turns: 2,
      interruptions: 1,
      avgFirstWordMs: 1001,
      avgFirstPartialMs: null,
      mode: "stream",
      streamFallbacks: 0,
      audioBytes: 4096,
    });
  });
});

describe("the fallback chain", () => {
  it("points a failed transcription at the record button, and a missing route at typing", () => {
    expect(fallbackFor("transcription", false)).toBe("recorded");
    expect(fallbackFor("transcription", true)).toBe("text");
  });

  it("keeps the call going in captions when only the voice is lost", () => {
    expect(fallbackFor("speech", true)).toBe("captions");
    expect(fallbackFor("turn", false)).toBe("captions");
  });

  it("sends a WAV-only route to recorded voice and says so quietly", () => {
    const d = degradation(new UnsupportedAudioError("reads wav only"), "transcription");
    expect(d.frame).toEqual({
      type: "unavailable",
      reason: "transcription_needs_wav",
      fallback: "recorded",
    });
    expect(d.level).toBe("info");
  });

  it("names a missing route and a failed provider differently", () => {
    const missing = degradation(new ProviderError("no route", "unsupported", false), "speech");
    expect(missing.frame.reason).toBe("no_speech_route");
    const failed = degradation(new Error("boom"), "turn");
    expect(failed.frame.reason).toBe("turn_failed");
    expect(failed.level).toBe("warn");
  });
});

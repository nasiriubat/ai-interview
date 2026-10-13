import { describe, expect, it } from "vitest";
import {
  looksLikeWav,
  parseWav,
  resample,
  WavFormatError,
  wavToWhisperInput,
} from "../../src/providers/local-whisper/wav.js";
import { tone, wav } from "./fixtures.js";

describe("WAV parsing for the on-server Whisper (D-75)", () => {
  it("reads 16-bit PCM mono at 16 kHz unchanged", () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 0.25]);
    const pcm = parseWav(wav({ channels: [samples], sampleRate: 16000, format: "pcm16" }));
    expect(pcm.sampleRate).toBe(16000);
    expect(pcm.samples.length).toBe(4);
    for (const [i, s] of samples.entries()) expect(pcm.samples[i]).toBeCloseTo(s, 3);
  });

  it("reads 32-bit float exactly", () => {
    const samples = Float32Array.from([0.1, -0.9, 0.333]);
    const pcm = parseWav(wav({ channels: [samples], sampleRate: 22050, format: "float32" }));
    expect(pcm.sampleRate).toBe(22050);
    expect(Array.from(pcm.samples)).toEqual(Array.from(samples));
  });

  it("averages stereo to mono", () => {
    const left = Float32Array.from([1, 0.5, 0]);
    const right = Float32Array.from([0, 0.5, -1]);
    const pcm = parseWav(wav({ channels: [left, right], sampleRate: 16000, format: "float32" }));
    expect(Array.from(pcm.samples)).toEqual([0.5, 0.5, -0.5]);
  });

  it("follows WAVE_FORMAT_EXTENSIBLE to the real sample format", () => {
    const pcm = parseWav(
      wav({ channels: [Float32Array.from([0.25])], sampleRate: 48000, format: "float32", extensible: true }),
    );
    expect(pcm.samples[0]).toBe(0.25);
  });

  it("skips chunks it does not need, including odd-sized ones", () => {
    const pcm = parseWav(
      wav({ channels: [Float32Array.from([0.5, 0.5])], sampleRate: 16000, format: "pcm16", junkChunk: true }),
    );
    expect(pcm.samples.length).toBe(2);
    expect(pcm.samples[0]).toBeCloseTo(0.5, 3);
  });

  it("resamples 44.1 kHz stereo to 16 kHz mono of the same duration", () => {
    const left = tone(1, 44100);
    const out = wavToWhisperInput(wav({ channels: [left, left], sampleRate: 44100, format: "pcm16" }));
    expect(out.length).toBe(16000);
    // The tone survives: a 440 Hz sine keeps its amplitude through a 16 kHz resample.
    const peak = out.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    expect(peak).toBeGreaterThan(0.25);
    expect(peak).toBeLessThanOrEqual(0.31);
  });

  it("upsamples 8 kHz by interpolation", () => {
    const out = resample(Float32Array.from([0, 1, 0, -1]), 8000, 16000);
    expect(out.length).toBe(8);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(1, 5);
  });

  it("returns the same array when the rate already matches", () => {
    const s = Float32Array.from([1, 2, 3]);
    expect(resample(s, 16000, 16000)).toBe(s);
  });

  it("recognises a WAV header and nothing else", () => {
    expect(looksLikeWav(wav({ channels: [new Float32Array(1)], sampleRate: 16000, format: "pcm16" }))).toBe(
      true,
    );
    // A WebM file starts with the EBML magic number.
    expect(looksLikeWav(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(looksLikeWav(new Uint8Array(3))).toBe(false);
  });

  it("refuses 8-bit and 24-bit PCM with a message that says what it accepts", () => {
    const bytes = wav({ channels: [new Float32Array(4)], sampleRate: 16000, format: "pcm16" });
    new DataView(bytes.buffer).setUint16(34, 24, true); // bits per sample
    expect(() => parseWav(bytes)).toThrow(WavFormatError);
    expect(() => parseWav(bytes)).toThrow(/16-bit PCM or 32-bit float/);
  });

  it("refuses a file with no data chunk", () => {
    const full = wav({ channels: [new Float32Array(0)], sampleRate: 16000, format: "pcm16" });
    expect(() => parseWav(full.subarray(0, 36))).toThrow(/No data chunk/);
  });

  it("reads to the end when a streaming recorder left the data size at zero", () => {
    const bytes = wav({ channels: [Float32Array.from([0.5, 0.5, 0.5])], sampleRate: 16000, format: "pcm16" });
    new DataView(bytes.buffer).setUint32(40, 0, true);
    expect(parseWav(bytes).samples.length).toBe(3);
  });
});

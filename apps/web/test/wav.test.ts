import { describe, expect, it, vi } from "vitest";
import {
  blobBytes,
  downmix,
  encodeWav16,
  resample,
  SPEECH_SAMPLE_RATE,
  toSpeechWav,
  type AudioDecoding,
} from "@/lib/audio/wav";

/** A stand-in for the AudioBuffer jsdom does not have. */
function audioBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const length = channels[0]?.length ?? 0;
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length,
    duration: length / sampleRate,
    getChannelData: (c: number) => channels[c] ?? new Float32Array(0),
  } as unknown as AudioBuffer;
}

function readHeader(buf: ArrayBuffer) {
  const v = new DataView(buf);
  const text = (at: number) => String.fromCharCode(...new Uint8Array(buf, at, 4));
  return {
    riff: text(0),
    wave: text(8),
    format: v.getUint16(20, true),
    channels: v.getUint16(22, true),
    rate: v.getUint32(24, true),
    bits: v.getUint16(34, true),
    dataBytes: v.getUint32(40, true),
    sample: (i: number) => v.getInt16(44 + i * 2, true),
  };
}

describe("converting a recording to WAV before upload (D-75)", () => {
  it("encodes 16-bit PCM mono with a correct header, clipping out-of-range samples", () => {
    const h = readHeader(encodeWav16(Float32Array.from([0, 1, -1, 2, -2, 0.5]), 16000));
    expect(h).toMatchObject({
      riff: "RIFF",
      wave: "WAVE",
      format: 1,
      channels: 1,
      rate: 16000,
      bits: 16,
      dataBytes: 12,
    });
    expect([0, 1, 2, 3, 4, 5].map(h.sample)).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it("averages stereo into mono", () => {
    expect(Array.from(downmix([Float32Array.from([1, 0]), Float32Array.from([0, -1])]))).toEqual([0.5, -0.5]);
  });

  it("resamples 48 kHz to 16 kHz keeping the duration", () => {
    const out = resample(new Float32Array(48000).fill(0.25), 48000, 16000);
    expect(out.length).toBe(16000);
    expect(out[100]).toBeCloseTo(0.25, 6);
  });

  it("uses the browser's resampler when there is one", async () => {
    const render = vi.fn(async (_a: AudioBuffer, rate: number) =>
      audioBuffer([new Float32Array(rate).fill(0.1)], rate),
    );
    const decoding: AudioDecoding = {
      decode: async () => audioBuffer([new Float32Array(44100), new Float32Array(44100)], 44100),
      render,
    };
    const wav = await toSpeechWav(new Blob(["opus"], { type: "audio/webm" }), decoding);
    expect(wav.type).toBe("audio/wav");
    expect(render).toHaveBeenCalledWith(expect.anything(), SPEECH_SAMPLE_RATE);
    const h = readHeader(await blobBytes(wav));
    expect(h.rate).toBe(16000);
    expect(h.dataBytes).toBe(32000);
  });

  it("resamples itself where OfflineAudioContext is missing", async () => {
    const decoding: AudioDecoding = {
      decode: async () => audioBuffer([new Float32Array(22050), new Float32Array(22050)], 44100),
    };
    const wav = await toSpeechWav(new Blob(["aac"], { type: "audio/mp4" }), decoding);
    expect(readHeader(await blobBytes(wav)).dataBytes).toBe(8000 * 2);
  });

  it("uploads the original when the browser cannot decode its own recording", async () => {
    const original = new Blob(["opus"], { type: "audio/webm" });
    const failing: AudioDecoding = { decode: () => Promise.reject(new Error("EncodingError")) };
    expect(await toSpeechWav(original, failing)).toBe(original);
    expect(await toSpeechWav(original, null)).toBe(original);
  });
});

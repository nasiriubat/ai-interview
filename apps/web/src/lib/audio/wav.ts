/**
 * Every finished recording becomes 16 kHz mono 16-bit PCM WAV before it is uploaded (D-75).
 *
 * The server can transcribe on its own CPU with Whisper, but Node cannot decode WebM/Opus
 * (Chrome, Firefox) or AAC in MP4 (Safari) without ffmpeg, and the browser decodes all of them
 * already. So the browser does the decoding and the server only has to read a WAV header. 16 kHz
 * mono is exactly what Whisper listens to, so nothing is lost; a minute is about 1.9 MB.
 *
 * The pure pieces (downmix, resample, encode) are exported so they can be tested without an
 * AudioContext, which jsdom does not have.
 */

export const SPEECH_SAMPLE_RATE = 16_000;

/** Averages channels into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (ch[i] ?? 0);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / channels.length;
  return out;
}

/**
 * Resamples mono audio: window averaging when shrinking (a crude low-pass against aliasing),
 * linear interpolation when growing. Only the fallback path uses it; normally
 * `OfflineAudioContext` resamples, and does it better.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  const last = samples.length - 1;
  for (let i = 0; i < out.length; i++) {
    if (ratio > 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j] ?? 0;
      out[i] = end > start ? sum / (end - start) : (samples[Math.min(start, last)] ?? 0);
    } else {
      const pos = i * ratio;
      const lo = Math.min(last, Math.floor(pos));
      const hi = Math.min(last, lo + 1);
      const frac = pos - lo;
      out[i] = (samples[lo] ?? 0) * (1 - frac) + (samples[hi] ?? 0) * frac;
    }
  }
  return out;
}

/** A RIFF/WAVE file of 16-bit PCM mono. Samples outside -1..1 are clipped rather than wrapped. */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return buffer;
}

/** The two Web Audio features the conversion needs; injectable so tests can fake them. */
export interface AudioDecoding {
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>;
  /** Renders the decoded audio at `rate`, mono. Absent where OfflineAudioContext is. */
  render?: (audio: AudioBuffer, rate: number) => Promise<AudioBuffer>;
}

type AudioContextCtor = new () => AudioContext;
type OfflineCtor = new (channels: number, length: number, rate: number) => OfflineAudioContext;

/** The browser's own decoder and resampler, or null where there is no Web Audio at all. */
export function browserAudioDecoding(): AudioDecoding | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
    OfflineAudioContext?: OfflineCtor;
    webkitOfflineAudioContext?: OfflineCtor;
  };
  const Ctx = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctx) return null;
  const Offline = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  return {
    decode: async (bytes) => {
      const ctx = new Ctx();
      try {
        return await ctx.decodeAudioData(bytes);
      } finally {
        void ctx.close().catch(() => undefined);
      }
    },
    ...(Offline
      ? {
          render: async (audio: AudioBuffer, rate: number) => {
            const length = Math.max(1, Math.ceil(audio.duration * rate));
            const offline = new Offline(1, length, rate);
            const source = offline.createBufferSource();
            source.buffer = audio;
            source.connect(offline.destination); // a mono destination downmixes as it goes
            source.start();
            return offline.startRendering();
          },
        }
      : {}),
  };
}

/** A blob's bytes. `Blob.arrayBuffer` is missing from Safari before 14 (and from jsdom). */
export function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as ArrayBuffer);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Could not read the recording"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function channelsOf(audio: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < audio.numberOfChannels; c++) out.push(audio.getChannelData(c));
  return out;
}

/**
 * The recording as 16 kHz mono WAV, or the original blob when this browser cannot decode it.
 *
 * The fallback is deliberate. A route to a cloud provider reads WebM and MP4 directly, so an
 * unconverted upload still works there; only the on-server Whisper refuses it, and the server says
 * so in words the participant can act on.
 */
export async function toSpeechWav(
  recording: Blob,
  decoding: AudioDecoding | null = browserAudioDecoding(),
): Promise<Blob> {
  if (!decoding) return recording;
  try {
    const decoded = await decoding.decode(await blobBytes(recording));
    let samples: Float32Array;
    if (decoding.render) {
      const rendered = await decoding.render(decoded, SPEECH_SAMPLE_RATE);
      samples = downmix(channelsOf(rendered));
    } else {
      samples = resample(downmix(channelsOf(decoded)), decoded.sampleRate, SPEECH_SAMPLE_RATE);
    }
    if (samples.length === 0) return recording;
    return new Blob([encodeWav16(samples, SPEECH_SAMPLE_RATE)], { type: "audio/wav" });
  } catch {
    return recording;
  }
}

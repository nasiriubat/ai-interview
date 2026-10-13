/**
 * WAV in, 16 kHz mono float samples out: the only audio the on-server Whisper accepts (D-75).
 *
 * Node cannot decode WebM/Opus or AAC without ffmpeg, and adding ffmpeg to the image is exactly
 * the kind of dependency this feature exists to avoid. So the browser does the decoding it is
 * already good at and uploads PCM in a WAV container; this file only has to read that container.
 * It still accepts any sample rate, channel count and the two common sample formats, because a
 * WAV from somewhere other than our own recorder (an uploaded file, a test fixture, `afconvert`)
 * should not fail on a detail that is cheap to handle.
 */

/** What Whisper was trained on; every model in the family expects it. */
export const WHISPER_SAMPLE_RATE = 16_000;

export interface PcmAudio {
  /** Mono, -1..1. */
  samples: Float32Array;
  sampleRate: number;
}

export class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavFormatError";
  }
}

/** True when the bytes start like a RIFF/WAVE file. Cheap enough to call before anything else. */
export function looksLikeWav(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && ascii(bytes, 0) === "RIFF" && ascii(bytes, 8) === "WAVE";
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Parses a RIFF/WAVE file into mono float samples at the file's own rate.
 *
 * Supported: integer PCM at 16 bits, float at 32 bits, any channel count (averaged to mono), and
 * WAVE_FORMAT_EXTENSIBLE wrapping either. Chunks it does not need (`LIST`, `fact`, ...) are
 * skipped, as the format requires.
 */
export function parseWav(bytes: Uint8Array): PcmAudio {
  if (!looksLikeWav(bytes)) throw new WavFormatError("Not a RIFF/WAVE file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: { start: number; length: number } | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16) throw new WavFormatError("fmt chunk is too short");
      let format = view.getUint16(body, true);
      // EXTENSIBLE carries the real format in the first two bytes of its sub-format GUID.
      if (format === FORMAT_EXTENSIBLE && size >= 40) format = view.getUint16(body + 24, true);
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      // A recorder that could not seek back writes 0 or 0xFFFFFFFF here; read to the end instead.
      const available = bytes.byteLength - body;
      data = { start: body, length: size === 0 || size > available ? available : size };
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt) throw new WavFormatError("No fmt chunk");
  if (!data) throw new WavFormatError("No data chunk");
  if (fmt.channels < 1) throw new WavFormatError("No channels");
  if (fmt.sampleRate < 1000 || fmt.sampleRate > 384_000)
    throw new WavFormatError(`Implausible sample rate ${fmt.sampleRate}`);

  const pcm16 = fmt.format === FORMAT_PCM && fmt.bits === 16;
  const float32 = fmt.format === FORMAT_FLOAT && fmt.bits === 32;
  if (!pcm16 && !float32)
    throw new WavFormatError(
      `Unsupported sample format ${fmt.format}/${fmt.bits}-bit; expected 16-bit PCM or 32-bit float`,
    );

  const bytesPerSample = fmt.bits / 8;
  const frameBytes = bytesPerSample * fmt.channels;
  const frames = Math.floor(data.length / frameBytes);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const frame = data.start + i * frameBytes;
    for (let c = 0; c < fmt.channels; c++) {
      const at = frame + c * bytesPerSample;
      sum += pcm16 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true);
    }
    samples[i] = sum / fmt.channels;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

/**
 * Resamples mono audio. Downsampling averages over each output sample's window before
 * interpolating, which is a crude low-pass but enough to keep 44.1/48 kHz speech from aliasing
 * into the band Whisper listens to; the browser's own resampler does better and is what normally
 * runs, so this is the path for WAV that did not come from our recorder.
 */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(length);
  const last = samples.length - 1;
  if (ratio > 1) {
    for (let i = 0; i < length; i++) {
      const start = i * ratio;
      const end = Math.min(samples.length, start + ratio);
      let sum = 0;
      let n = 0;
      for (let j = Math.floor(start); j < end; j++) {
        sum += samples[j] ?? 0;
        n++;
      }
      out[i] = n > 0 ? sum / n : 0;
    }
    return out;
  }
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const lo = Math.min(last, Math.floor(pos));
    const hi = Math.min(last, lo + 1);
    const frac = pos - lo;
    out[i] = (samples[lo] ?? 0) * (1 - frac) + (samples[hi] ?? 0) * frac;
  }
  return out;
}

/** WAV bytes to exactly what Whisper wants: 16 kHz mono float. */
export function wavToWhisperInput(bytes: Uint8Array): Float32Array {
  const pcm = parseWav(bytes);
  return resample(pcm.samples, pcm.sampleRate, WHISPER_SAMPLE_RATE);
}

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

import type {
  LanguageHint,
  SpeechResult,
  SpeechToTextEngine,
} from "../../src/providers/local-whisper/runner.js";

/** Builds a WAV file in memory, with an optional extra chunk before `fmt ` to prove it is skipped. */
export function wav(opts: {
  channels: Float32Array[];
  sampleRate: number;
  format: "pcm16" | "float32";
  extensible?: boolean;
  junkChunk?: boolean;
}): Uint8Array {
  const frames = opts.channels[0]?.length ?? 0;
  const channels = opts.channels.length;
  const bytesPerSample = opts.format === "pcm16" ? 2 : 4;
  const dataBytes = frames * channels * bytesPerSample;
  const fmtBytes = opts.extensible ? 40 : 16;
  const junk = opts.junkChunk ? 8 + 5 + 1 : 0; // odd-sized chunk plus its pad byte
  const buf = new ArrayBuffer(12 + junk + 8 + fmtBytes + 8 + dataBytes);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  let o = 0;
  text(o, "RIFF");
  view.setUint32(o + 4, buf.byteLength - 8, true);
  text(o + 8, "WAVE");
  o = 12;
  if (opts.junkChunk) {
    text(o, "LIST");
    view.setUint32(o + 4, 5, true);
    o += 8 + 5 + 1;
  }
  const code = opts.format === "pcm16" ? 1 : 3;
  text(o, "fmt ");
  view.setUint32(o + 4, fmtBytes, true);
  view.setUint16(o + 8, opts.extensible ? 0xfffe : code, true);
  view.setUint16(o + 10, channels, true);
  view.setUint32(o + 12, opts.sampleRate, true);
  view.setUint32(o + 16, opts.sampleRate * channels * bytesPerSample, true);
  view.setUint16(o + 20, channels * bytesPerSample, true);
  view.setUint16(o + 22, bytesPerSample * 8, true);
  if (opts.extensible) {
    view.setUint16(o + 24, 22, true);
    view.setUint16(o + 32, code, true); // first two bytes of the sub-format GUID
  }
  o += 8 + fmtBytes;
  text(o, "data");
  view.setUint32(o + 4, dataBytes, true);
  o += 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = opts.channels[c]?.[i] ?? 0;
      if (opts.format === "pcm16") view.setInt16(o, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true);
      else view.setFloat32(o, s, true);
      o += bytesPerSample;
    }
  }
  return bytes;
}

export function tone(seconds: number, sampleRate: number, amplitude = 0.3, hz = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The in-memory engine. By default everything resolves at once; a test that needs to hold a load
 * or a transcription open sets `holdLoad` / `holdRun` and resolves them itself.
 */
export class FakeEngine implements SpeechToTextEngine {
  loads: { model: string; dtype: string }[] = [];
  runs: { model: string; seconds: number; language: string | undefined; candidates?: string[] }[] = [];
  resets = 0;
  running = 0;
  maxRunning = 0;
  holdLoad: Deferred<undefined> | undefined;
  holdRun: Deferred<SpeechResult>[] = [];
  failLoad: Error | undefined;
  reply: (language: string | undefined) => SpeechResult = (language) => ({
    text: " heard ",
    ...(language === undefined ? {} : { language }),
  });

  async load(model: string, dtype: string, onProgress: (f: number | undefined) => void): Promise<void> {
    this.loads.push({ model, dtype });
    onProgress(0.5);
    if (this.failLoad) throw this.failLoad;
    if (this.holdLoad) await this.holdLoad.promise;
  }

  async transcribe(model: string, audio: Float32Array, hint: LanguageHint): Promise<SpeechResult> {
    const language = hint.language;
    this.runs.push({
      model,
      seconds: audio.length / 16000,
      language,
      ...(hint.candidates ? { candidates: hint.candidates } : {}),
    });
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      const hold = this.holdRun.shift();
      if (hold) return await hold.promise;
      return this.reply(language);
    } finally {
      this.running--;
    }
  }

  async reset(): Promise<void> {
    this.resets++;
  }
}

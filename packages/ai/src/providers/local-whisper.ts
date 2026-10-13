import {
  emptyUsage,
  type Capabilities,
  type ChatEvent,
  type ChatRequest,
  type ModelInfo,
  type Transcript,
  type TranscriptionInput,
  type Usage,
} from "@aidp/shared";
import type { z } from "zod";
import { localWhisperModel, LOCAL_WHISPER_MODELS } from "./local-whisper/models.js";
import { localSpeechRunner, type SpeechRunner } from "./local-whisper/runner.js";
import { looksLikeWav, WavFormatError, wavToWhisperInput, WHISPER_SAMPLE_RATE } from "./local-whisper/wav.js";
import { ProviderError, UnsupportedAudioError, type Provider } from "./types.js";

export interface LocalWhisperOptions {
  id: string;
  /** Test seam; production shares the one process-wide runner. */
  runner?: SpeechRunner;
}

/**
 * Speech to text on the server itself (D-75): Whisper through transformers.js, no API key, and the
 * audio never leaves the machine.
 *
 * Transcription only. It reads WAV and nothing else — the browser converts each recording to
 * 16 kHz mono PCM before uploading, because decoding WebM/Opus or AAC in Node would need ffmpeg in
 * the image. Everything it reports is free: the ledger still gets a row per call, at zero cost, so
 * the admin can see the volume.
 */
export class LocalWhisperProvider implements Provider {
  readonly id: string;
  readonly kind = "local" as const;
  readonly capabilities: Capabilities = {
    caching: false,
    structuredOutput: false,
    effort: false,
    batch: false,
    vision: false,
    transcription: true,
    speech: false,
    // A finished recording only: no socket to stream into (D-75). Live calls need OpenAI (D-77).
    streamingTranscription: false,
  };
  private readonly runnerOverride: SpeechRunner | undefined;

  constructor(opts: LocalWhisperOptions) {
    this.id = opts.id;
    this.runnerOverride = opts.runner;
  }

  async listModels(): Promise<ModelInfo[]> {
    return LOCAL_WHISPER_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      inputPerMtok: 0,
      cachedInputPerMtok: 0,
      outputPerMtok: 0,
    }));
  }

  // eslint-disable-next-line require-yield -- an adapter that cannot chat still has to look like one
  async *chat(): AsyncIterable<ChatEvent> {
    throw new ProviderError("The on-server Whisper provider only transcribes audio", "unsupported", false);
  }

  async complete<T>(
    _model: string,
    _req: ChatRequest,
    _schema: z.ZodType<T>,
  ): Promise<{ value: T; usage: Usage }> {
    throw new ProviderError("The on-server Whisper provider only transcribes audio", "unsupported", false);
  }

  async transcribe(
    model: string,
    input: TranscriptionInput,
  ): Promise<{ transcript: Transcript; usage: Usage }> {
    if (!localWhisperModel(model)) {
      throw new ProviderError(
        `'${model}' is not a model this server runs; choose one of ${LOCAL_WHISPER_MODELS.map((m) => m.id).join(", ")}`,
        "bad_request",
        false,
      );
    }
    if (!looksLikeWav(input.data)) {
      throw new UnsupportedAudioError(
        `The on-server Whisper reads WAV only, and this recording is ${input.mime}; the browser should have converted it to 16 kHz PCM WAV before uploading`,
      );
    }
    let samples: Float32Array;
    try {
      samples = wavToWhisperInput(input.data);
    } catch (err) {
      if (err instanceof WavFormatError)
        throw new UnsupportedAudioError(`Unreadable WAV: ${err.message}`, err);
      throw err;
    }
    const durationSeconds = samples.length / WHISPER_SAMPLE_RATE;
    // Whisper does not return nothing for nothing: fed silence it tends to invent a sign-off
    // ("Thank you for watching"), which would become the participant's answer. Silence is caught
    // here instead, and becomes the empty transcript the voice route already explains.
    if (durationSeconds < 0.2 || isSilent(samples)) {
      return { transcript: { text: "", durationSeconds }, usage: emptyUsage() };
    }
    const runner = this.runnerOverride ?? localSpeechRunner();
    const language = whisperLanguage(input.language);
    const candidates = [
      ...new Set((input.languages ?? []).map(whisperLanguage).filter((c) => c !== undefined)),
    ];
    const out = await runner.transcribe(model, samples, {
      ...(language ? { language } : {}),
      ...(!language && candidates.length ? { candidates } : {}),
    });
    return { transcript: { text: out.text.trim(), durationSeconds }, usage: emptyUsage() };
  }
}

/** Loudness, as root-mean-square over 100 ms windows, below which a recording holds no speech. */
const SILENCE_RMS = 0.004;

/** True when no 100 ms window of the audio rises above room noise. */
export function isSilent(samples: Float32Array, sampleRate = WHISPER_SAMPLE_RATE): boolean {
  const window = Math.max(1, Math.round(sampleRate / 10));
  for (let start = 0; start < samples.length; start += window) {
    const end = Math.min(samples.length, start + window);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i] ?? 0;
      sum += s * s;
    }
    if (Math.sqrt(sum / (end - start)) >= SILENCE_RMS) return false;
  }
  return true;
}

/**
 * A language hint as Whisper wants it: an ISO 639-1 code. `fi-FI` and `FI` become `fi`; anything
 * that is not a plain code is dropped, and the model identifies the language itself.
 */
export function whisperLanguage(hint: string | undefined): string | undefined {
  const code = hint?.trim().toLowerCase().split(/[-_]/)[0];
  return code && /^[a-z]{2,3}$/.test(code) ? code : undefined;
}

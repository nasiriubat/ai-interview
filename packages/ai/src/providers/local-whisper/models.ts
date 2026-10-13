/**
 * The Whisper models the `local` provider will run (D-75).
 *
 * An allow-list rather than any Hugging Face id, because the route's `model` field is free text a
 * tenant admin can edit, and "any id" would let one tenant make the server download gigabytes and
 * hold them in memory. Every entry is an ONNX export under `onnx-community`, which transformers.js
 * loads without conversion.
 *
 * `q8` everywhere. Measured on whisper-small with a Finnish sentence (see apps/web/README.md,
 * "Voice and files"): q8 gave word-for-word the same transcript as an fp32 encoder with a q8
 * decoder, in the same time, with a 250 MB download instead of 510 MB and roughly 0.5 GB less
 * resident memory. The accuracy that matters for Finnish comes from model size, not precision:
 * whisper-base at q8 made four mistakes in the same sentence that whisper-small did not.
 */
export interface LocalWhisperModel {
  id: string;
  name: string;
  /** transformers.js `dtype`: which of the exported weight files to fetch. */
  dtype: "q8" | "fp32" | "fp16" | "q4";
  /** Approximate download, for the admin who is choosing. */
  downloadMb: number;
}

export const DEFAULT_LOCAL_WHISPER_MODEL = "onnx-community/whisper-small";

export const LOCAL_WHISPER_MODELS: readonly LocalWhisperModel[] = [
  {
    id: DEFAULT_LOCAL_WHISPER_MODEL,
    name: "Whisper small, on this server (about 250 MB, good Finnish)",
    dtype: "q8",
    downloadMb: 250,
  },
  {
    id: "onnx-community/whisper-base",
    name: "Whisper base, on this server (about 80 MB, faster, weaker Finnish)",
    dtype: "q8",
    downloadMb: 80,
  },
  {
    id: "onnx-community/whisper-large-v3-turbo",
    name: "Whisper large v3 turbo, on this server (about 1.1 GB, best accuracy, needs 4+ GB RAM)",
    dtype: "q8",
    downloadMb: 1090,
  },
];

export function localWhisperModel(id: string): LocalWhisperModel | undefined {
  return LOCAL_WHISPER_MODELS.find((m) => m.id === id);
}

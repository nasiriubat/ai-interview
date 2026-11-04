import type { Route } from "@aidp/shared";

type RouteRow = (
  purpose: Route["purpose"],
  model: string,
  effort: Route["effort"],
  maxOutputTokens: number,
  batchAllowed?: boolean,
) => Route;

const rowFor =
  (providerId: string): RouteRow =>
  (purpose, model, effort, maxOutputTokens, batchAllowed = false) => ({
    companyId: null,
    purpose,
    providerId,
    model,
    effort,
    maxOutputTokens,
    batchAllowed,
  });

/**
 * Platform default routes for an Anthropic provider. Chatty, frequent purposes run on
 * the fast tier at low effort; the one-shot, quality-critical purposes run on the
 * strongest tier. Admins override any row per tenant from the dashboard.
 * `transcription` and `embedding` have no Anthropic default: they need an OpenAI-compatible provider.
 */
export function defaultAnthropicRoutes(providerId: string): Route[] {
  const r = rowFor(providerId);
  return [
    r("interview_turn", "claude-sonnet-5", "low", 4096),
    r("resume_summary", "claude-sonnet-5", "low", 2048),
    r("extraction", "claude-sonnet-5", "medium", 8192, true),
    r("clustering", "claude-opus-5", "medium", 16000, true),
    r("analysis_report", "claude-opus-5", "medium", 8000),
    r("spec_turn", "claude-opus-5", "medium", 2048),
    r("issue_detection", "claude-sonnet-5", "medium", 4096),
    r("spec_generation", "claude-opus-5", "high", 64000),
    r("file_ingest", "claude-sonnet-5", "low", 4096, true),
    r("vision_ingest", "claude-sonnet-5", "low", 4096, true),
  ];
}

/**
 * The same tiers through OpenRouter (model slugs are `vendor/model`). OpenRouter ignores
 * the effort field and does not batch; the rows keep the values for documentation.
 */
export function defaultOpenRouterRoutes(providerId: string): Route[] {
  const r = rowFor(providerId);
  const fast = "anthropic/claude-sonnet-5";
  const strong = "anthropic/claude-opus-5";
  return [
    r("interview_turn", fast, "low", 4096),
    r("resume_summary", fast, "low", 2048),
    r("extraction", fast, "medium", 8192),
    r("clustering", strong, "medium", 16000),
    r("analysis_report", strong, "medium", 8000),
    r("spec_turn", strong, "medium", 2048),
    r("issue_detection", fast, "medium", 4096),
    r("spec_generation", strong, "high", 64000),
    r("file_ingest", fast, "low", 4096),
    r("vision_ingest", fast, "low", 4096),
  ];
}

/**
 * Meta's Model API (D-495). Muse Spark is one model for every text purpose; the effort field does
 * the tiering here, sent as `reasoning_effort` (the adapter turns a low or medium route into
 * `minimal`, as ModelCaller asks for no hidden reasoning below high effort). Only the standard
 * model: the `-contributor` variants let the vendor train on prompts, which interview data must not
 * allow. An admin changes any row, or moves every task to another provider, in Model assignment.
 */
export const META_DEFAULT_MODEL = "muse-spark-1.3";

export function defaultMetaRoutes(providerId: string, model: string = META_DEFAULT_MODEL): Route[] {
  const r = rowFor(providerId);
  return [
    r("interview_turn", model, "low", 4096),
    r("resume_summary", model, "low", 2048),
    r("extraction", model, "medium", 8192),
    r("clustering", model, "medium", 16000),
    r("analysis_report", model, "medium", 8000),
    r("spec_turn", model, "medium", 2048),
    r("issue_detection", model, "medium", 4096),
    r("spec_generation", model, "high", 64000),
    r("file_ingest", model, "low", 4096),
    r("vision_ingest", model, "low", 4096),
  ];
}

/**
 * OpenAI's recommended model for live transcription (checked September 2026: "Start with
 * gpt-live-transcribe"), priced per minute of audio. Used by the bootstrap and by the admin's
 * one-step live voice setup, so both route the same model.
 */
export const LIVE_TRANSCRIPTION_MODEL = "gpt-live-transcribe";

/** The `tts` and `transcription` models the one-step setup routes, the same as the bootstrap. */
export const DEFAULT_TTS_MODEL = "tts-1";
export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";

/**
 * The purposes only an OpenAI-compatible provider can serve.
 *
 * Deliberately narrow. Anthropic and OpenRouter cover the conversation perfectly well, and this
 * exists to fill the holes they leave: audio in, audio out, and vectors. A deployment with
 * an OpenRouter key and an OpenAI key gets a complete system — interviews on whichever models it
 * prefers, semantic clustering instead of word overlap, and a voice — without configuring a route
 * by hand.
 *
 * `stt_stream` is the live captions of a voice call (D-77, D-80): the one purpose in the set that
 * is a socket rather than a request, on the model OpenAI recommends for live audio.
 *
 * `whisper-1` and `tts-1` rather than the newest models on purpose: both are an order of magnitude
 * cheaper than their successors, and a voice interview pays per second of conversation. An admin
 * who wants the better voice changes one row.
 */
export function defaultOpenAIRoutes(providerId: string): Route[] {
  const r = rowFor(providerId);
  return [
    r("transcription", DEFAULT_TRANSCRIPTION_MODEL, "low", 0),
    r("stt_stream", LIVE_TRANSCRIPTION_MODEL, "low", 0),
    r("tts", DEFAULT_TTS_MODEL, "low", 0),
    r("embedding", "text-embedding-3-small", "low", 0),
  ];
}

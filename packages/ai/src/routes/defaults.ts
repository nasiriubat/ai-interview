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
 * The purposes only an OpenAI-compatible provider can serve.
 *
 * Deliberately narrow. Anthropic and OpenRouter cover the conversation perfectly well, and this
 * exists to fill the three holes they leave: audio in, audio out, and vectors. A deployment with
 * an OpenRouter key and an OpenAI key gets a complete system — interviews on whichever models it
 * prefers, semantic clustering instead of word overlap, and a voice — without configuring a route
 * by hand.
 *
 * `whisper-1` and `tts-1` rather than the newest models on purpose: both are an order of magnitude
 * cheaper than their successors, and a voice interview pays per second of conversation. An admin
 * who wants the better voice changes one row.
 */
export function defaultOpenAIRoutes(providerId: string): Route[] {
  const r = rowFor(providerId);
  return [
    r("transcription", "whisper-1", "low", 0),
    r("tts", "tts-1", "low", 0),
    r("embedding", "text-embedding-3-small", "low", 0),
  ];
}

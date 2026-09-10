import type { Route } from "@aidp/shared";

/**
 * Platform default routes for an Anthropic provider. Chatty, frequent purposes run on
 * the fast tier at low effort; the one-shot, quality-critical purposes run on the
 * strongest tier. Admins override any row per tenant from the dashboard.
 * `transcription` has no Anthropic default: it needs an OpenAI-compatible provider.
 */
export function defaultAnthropicRoutes(providerId: string): Route[] {
  const r = (
    purpose: Route["purpose"],
    model: string,
    effort: Route["effort"],
    maxOutputTokens: number,
    batchAllowed = false,
  ): Route => ({
    companyId: null,
    purpose,
    providerId,
    model,
    effort,
    maxOutputTokens,
    batchAllowed,
  });
  return [
    r("interview_turn", "claude-sonnet-5", "low", 1024),
    r("resume_summary", "claude-sonnet-5", "low", 2048),
    r("extraction", "claude-sonnet-5", "medium", 8192, true),
    r("clustering", "claude-opus-5", "medium", 16000, true),
    r("spec_turn", "claude-opus-5", "medium", 2048),
    r("spec_generation", "claude-opus-5", "high", 64000),
    r("file_ingest", "claude-sonnet-5", "low", 4096, true),
    r("vision_ingest", "claude-sonnet-5", "low", 4096, true),
  ];
}

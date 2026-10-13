import { z } from "zod";

/** Every model call is made for exactly one purpose. Routing and budgets are per purpose. */
export const PURPOSES = [
  "interview_turn",
  "resume_summary",
  "extraction",
  "clustering",
  "analysis_report",
  "spec_turn",
  "issue_detection",
  "spec_generation",
  "transcription",
  "stt_stream",
  "tts",
  "realtime_voice",
  "file_ingest",
  "vision_ingest",
  "embedding",
  /**
   * "Does this provider answer?" from the admin screen. Ledgered like any call, but never routed
   * (the caller names the provider and model) and never counted against a budget; it has its own
   * small daily cap instead (D-106). It exists so the one model call that used to bypass
   * `ModelCaller` goes through it.
   */
  "probe",
] as const;
export const PurposeSchema = z.enum(PURPOSES);
export type Purpose = z.infer<typeof PurposeSchema>;

/** The purposes a route can be configured for: every one except the unrouted `probe`. */
export const ROUTABLE_PURPOSES = PURPOSES.filter((p) => p !== "probe");
export const RoutablePurposeSchema = PurposeSchema.exclude(["probe"]);
export type RoutablePurpose = z.infer<typeof RoutablePurposeSchema>;

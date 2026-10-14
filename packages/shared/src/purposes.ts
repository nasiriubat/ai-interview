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

/**
 * Purposes that exist in the enum but nothing calls yet. Live voice is a cascade of `stt_stream`,
 * `interview_turn` and `tts` (D-75, D-77); a single speech-to-speech model is a later design, so
 * `realtime_voice` is hidden from the routes screen and refused by `PUT /routes` until it has a
 * reader (D-187). Stored rows are not touched.
 */
export const PLANNED_PURPOSES = ["realtime_voice"] as const;

/** The purposes a route can be configured for: all but the unrouted `probe` and the planned ones. */
export const ROUTABLE_PURPOSES = PURPOSES.filter(
  (p) => p !== "probe" && !(PLANNED_PURPOSES as readonly string[]).includes(p),
);
export const RoutablePurposeSchema = PurposeSchema.exclude(["probe", ...PLANNED_PURPOSES]);
export type RoutablePurpose = z.infer<typeof RoutablePurposeSchema>;

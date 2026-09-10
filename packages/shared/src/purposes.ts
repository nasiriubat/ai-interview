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
] as const;
export const PurposeSchema = z.enum(PURPOSES);
export type Purpose = z.infer<typeof PurposeSchema>;

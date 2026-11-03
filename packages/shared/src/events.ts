import { z } from "zod";

/**
 * Every type of `SessionEvent` the code writes (blueprint feature 15, D-179).
 *
 * The table is an append-only log of what happened to a session that is not a message: engine
 * bookkeeping, controls the participant used, an administrator's notes. It was written with free
 * strings, so a typo became a new event type nobody read. `appendEvent` now takes this union, and
 * a test scans the source for the literals it is called with.
 *
 * - `state_delta`: what the model asked to change in state on a turn, with the focus and reason.
 * - `finding`: a requirements finding detected, raised, pushed back on or settled.
 * - `flag`: the engine flagged the interview for hostility or distress (D-173).
 * - `facts_extracted`: one extraction batch was committed.
 * - `control`: the participant skipped an area, came back to one, or finished (D-170).
 * - `mode_switch`: the answer mode changed (D-171).
 * - `resume`: the participant came back and a recap was written for them (D-172).
 * - `admin_note`: a note an administrator left, for instance when acknowledging a flag.
 * - `spec_edit`: the owner edited a section of a requirements specification.
 * - `invitation`: an invitation into a requirements session was sent, opened or revoked.
 * - `voice.live`: the per-session signals of a live voice call, written once at its end. The name
 *   keeps its dot because rows exist under it; a per-turn `voice_metrics` event was considered and
 *   not added, since a row per spoken turn costs more than the numbers are worth (D-179).
 */
export const SESSION_EVENT_TYPES = [
  "state_delta",
  "finding",
  "flag",
  "facts_extracted",
  "control",
  "mode_switch",
  "resume",
  "admin_note",
  "spec_edit",
  "invitation",
  "voice.live",
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/** Why the answer mode changed: the participant chose it, or the client fell back (contract 16). */
export const ModeSwitchReasonSchema = z.enum([
  "participant",
  "fallback_captions",
  "fallback_typing",
  "unavailable",
]);
export type ModeSwitchReason = z.infer<typeof ModeSwitchReasonSchema>;

export const ModeSwitchEventSchema = z.object({
  from: z.string(),
  to: z.enum(["chat", "options", "voice"]),
  reason: ModeSwitchReasonSchema,
});
export type ModeSwitchEvent = z.infer<typeof ModeSwitchEventSchema>;

export const ControlEventSchema = z.object({
  kind: z.enum(["skip_area", "return_area", "finish", "wrap_up"]),
  areaKey: z.string().optional(),
  areaName: z.string().optional(),
  /** The sequence of the last message before the control, so a timeline can place it. */
  afterSeq: z.number().int().nonnegative(),
});
export type ControlEvent = z.infer<typeof ControlEventSchema>;

export const ResumeEventSchema = z.object({
  source: z.enum(["model", "fallback"]),
  idleMinutes: z.number().int().nonnegative(),
});
export type ResumeEvent = z.infer<typeof ResumeEventSchema>;

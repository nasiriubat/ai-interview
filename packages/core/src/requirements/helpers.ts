import {
  SessionInvitationSchema,
  SpecEditsSchema,
  SpecVersionStatsSchema,
  type Path,
  type SessionInvitation,
  type SessionState,
  type SpecEdits,
} from "@aidp/shared";
import type { SpecVersion } from "@prisma/client";
import { z } from "zod";
import type { SpecVersionSummary } from "./types.js";

export const REQUIREMENTS_TEMPLATE_KEY = "requirements_discovery";
export const INVITE_DAYS = 30;

/** Stored invitation: the public shape plus the token hash that never leaves the server. */
const StoredInvitationSchema = SessionInvitationSchema.extend({ tokenHash: z.string().default("") });
export type StoredInvitation = z.infer<typeof StoredInvitationSchema>;

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function pathOf(value: string | null): Path | null {
  return value === "technical" || value === "nontechnical" ? value : null;
}

export function parseEdits(value: unknown): SpecEdits {
  const parsed = SpecEditsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

export function storedInvitations(value: unknown): StoredInvitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const parsed = StoredInvitationSchema.safeParse(v);
    return parsed.success ? [parsed.data] : [];
  });
}

export function publicInvitation(i: StoredInvitation): SessionInvitation {
  const { tokenHash: _hash, ...rest } = i;
  return rest;
}

export function publicInvitations(value: unknown): SessionInvitation[] {
  return storedInvitations(value).map(publicInvitation);
}

export function versionSummary(v: SpecVersion): SpecVersionSummary {
  const stats = SpecVersionStatsSchema.safeParse(v.stats);
  return {
    id: v.id,
    version: v.version,
    ...(v.label ? { label: v.label } : {}),
    status: v.status,
    ...(v.error ? { error: v.error } : {}),
    ...(v.createdBy ? { createdBy: v.createdBy } : {}),
    createdAt: v.createdAt,
    ...(v.finishedAt ? { finishedAt: v.finishedAt } : {}),
    stats: stats.success ? stats.data : SpecVersionStatsSchema.parse({}),
  };
}

export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "spec";
}

/** Turns a reopened session is given to continue in, scaled to the cap but never fewer than 5 nor more than 15. */
export function reopenRoom(maxTurns: number): number {
  return Math.min(15, Math.max(5, Math.round(maxTurns * 0.2)));
}

/**
 * The state a completed session resumes from (FR-26).
 *
 * Reopening used to keep `min(turnCount, assistantMessages)`. A session that ended by hitting the
 * cap, or by "I'm done" (which writes `COMPLETION_REQUESTED_TURN_COUNT`), came back at or above
 * `maxTurns`, so the engine's next focus was "closing" and the session re-closed on its first turn
 * (live run 2026-10-14, bug 6). The count is brought below the cap by `reopenRoom`, the request to
 * finish is cleared with it, and the walks that ended are allowed to run again for new material:
 * the issue scan, the closing question, and the MVP challenge (items already asked stay asked).
 */
export function reopenedState(state: SessionState, assistantTurns: number, maxTurns: number): SessionState {
  const working = Math.max(0, Math.min(state.turnCount, assistantTurns, maxTurns - reopenRoom(maxTurns)));
  return {
    ...state,
    phase: "areas",
    closingAsked: false,
    finalIssueScanDone: false,
    turnCount: working,
    lastIssueScanTurn: Math.min(state.lastIssueScanTurn, working),
    lastWidgetTurn: Math.min(state.lastWidgetTurn, working),
    mvpChallenge: { ...state.mvpChallenge, done: false },
  };
}

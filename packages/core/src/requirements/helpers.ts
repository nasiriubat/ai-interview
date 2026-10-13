import {
  SessionInvitationSchema,
  SpecEditsSchema,
  SpecVersionStatsSchema,
  type Path,
  type SessionInvitation,
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

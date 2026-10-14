import { settingDefault, type SettingKey } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import type { SettingScopeRef, SettingsService } from "./service.js";

/**
 * A boolean switch resolved as an AND across every scope that has a value (D-186): the platform,
 * the tenant, the template. A narrower scope may switch a capability off for itself but never on
 * where a wider one has turned it off. Nobody having set it means the catalog default.
 */
export async function switchEnabled(
  settings: Pick<SettingsService, "valuesAcrossScopes">,
  key: SettingKey,
  chain: SettingScopeRef[],
): Promise<boolean> {
  const values = await settings.valuesAcrossScopes(key, chain);
  if (values.length === 0) return settingDefault(key) === true;
  return values.every((v) => v === true);
}

export type VoiceMode = "recorded" | "live";

/**
 * Whether voice of this kind is available for a template in a tenant: the tenant-level feature
 * flag (most specific scope wins, as before) and the per-template `voice.enabled` switch, which
 * is an AND across scopes.
 */
export async function voiceAllowed(
  settings: Pick<SettingsService, "valuesAcrossScopes" | "get">,
  input: { companyId: string; templateId: string | null | undefined; mode: VoiceMode },
): Promise<boolean> {
  const tenant = { scope: "tenant" as const, scopeId: input.companyId };
  const key = input.mode === "live" ? "features.realtimeVoice" : "features.recordedVoice";
  if (!(await settings.get(key, [tenant]))) return false;
  const chain: SettingScopeRef[] = [
    ...(input.templateId ? [{ scope: "template" as const, scopeId: input.templateId }] : []),
    tenant,
  ];
  return switchEnabled(settings, "voice.enabled", chain);
}

/**
 * `voiceAllowed` for a session: the template is the one the session pinned, so the answer is the
 * same for the whole interview even if the template is edited meanwhile (a new version is a new
 * row, and its settings are carried forward, not shared).
 */
export async function voiceAllowedForSession(
  db: Pick<PrismaClient, "session">,
  settings: Pick<SettingsService, "valuesAcrossScopes" | "get">,
  input: { companyId: string; sessionId: string; mode: VoiceMode },
): Promise<boolean> {
  const session = await db.session.findFirst({
    where: { id: input.sessionId, companyId: input.companyId },
    select: { templateId: true },
  });
  return voiceAllowed(settings, {
    companyId: input.companyId,
    templateId: session?.templateId,
    mode: input.mode,
  });
}

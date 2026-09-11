import { SPEC_SECTION_KEYS, type SpecSectionKey } from "@aidp/shared";
import { t } from "@/i18n";

function isSectionKey(key: string): key is SpecSectionKey {
  return (SPEC_SECTION_KEYS as readonly string[]).includes(key);
}

/** The localized title of a spec section; unknown keys fall back to the API's title or the key itself. */
export function sectionTitle(key: string, fallback?: string | null): string {
  if (isSectionKey(key)) return t.admin.requirements.sectionNames[key];
  return fallback?.trim() ? fallback : key;
}

type SourceKind = keyof typeof t.admin.requirements.sources;
const SOURCE_KINDS: readonly string[] = ["text", "handoff", "invitation", "attachment"];

/** The localized label of a session's `sourceKind`, or undefined for kinds the UI does not know. */
export function sourceLabel(kind: string | null | undefined): string | undefined {
  if (!kind || !SOURCE_KINDS.includes(kind)) return undefined;
  return t.admin.requirements.sources[kind as SourceKind];
}

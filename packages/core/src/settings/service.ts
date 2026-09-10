import {
  SETTINGS,
  parseSetting,
  settingDefault,
  type SettingKey,
  type SettingScope,
  type SettingValue,
} from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";

export interface SettingScopeRef {
  scope: SettingScope;
  scopeId: string; // "" for platform
}

/**
 * Resolves the effective value of a setting: campaign > template > tenant > platform > catalog default.
 * Writes validate against the catalog and record who changed what (ADM knobs, FR-51).
 */
export class SettingsService {
  constructor(private readonly db: PrismaClient) {}

  async get<K extends SettingKey>(key: K, chain: SettingScopeRef[]): Promise<SettingValue<K>> {
    const values = await this.resolveMany([key], chain);
    return values[key] as SettingValue<K>;
  }

  /** Effective values for many keys at once. `chain` is ordered most specific first. */
  async resolveMany(
    keys: SettingKey[],
    chain: SettingScopeRef[],
  ): Promise<Partial<Record<SettingKey, unknown>>> {
    const withPlatform = [
      ...chain.filter((c) => c.scope !== "platform"),
      { scope: "platform" as const, scopeId: "" },
    ];
    const rows = await this.db.setting.findMany({
      where: { key: { in: keys }, OR: withPlatform.map((c) => ({ scope: c.scope, scopeId: c.scopeId })) },
    });
    const out: Partial<Record<SettingKey, unknown>> = {};
    for (const key of keys) {
      let value: unknown = settingDefault(key);
      for (const ref of [...withPlatform].reverse()) {
        const row = rows.find((r) => r.key === key && r.scope === ref.scope && r.scopeId === ref.scopeId);
        if (row && SETTINGS[key].scopes.includes(ref.scope)) value = parseSetting(key, row.value);
      }
      out[key] = value;
    }
    return out;
  }

  /** Raw values set at exactly one scope, for the admin editor. */
  async listAt(ref: SettingScopeRef): Promise<Partial<Record<SettingKey, unknown>>> {
    const rows = await this.db.setting.findMany({ where: { scope: ref.scope, scopeId: ref.scopeId } });
    const out: Partial<Record<SettingKey, unknown>> = {};
    for (const r of rows) if (r.key in SETTINGS) out[r.key as SettingKey] = r.value;
    return out;
  }

  async set(
    ref: SettingScopeRef,
    values: Record<string, unknown>,
    changedBy: string | null,
  ): Promise<SettingKey[]> {
    const written: SettingKey[] = [];
    for (const [k, v] of Object.entries(values)) {
      if (!(k in SETTINGS)) throw new SettingsError(`Unknown setting '${k}'`);
      const key = k as SettingKey;
      if (!SETTINGS[key].scopes.includes(ref.scope))
        throw new SettingsError(`Setting '${key}' cannot be set at scope '${ref.scope}'`);
      if (v === null) {
        await this.db.setting.deleteMany({ where: { scope: ref.scope, scopeId: ref.scopeId, key } });
        written.push(key);
        continue;
      }
      const parsed = parseSetting(key, v);
      await this.db.setting.upsert({
        where: { scope_scopeId_key: { scope: ref.scope, scopeId: ref.scopeId, key } },
        create: { scope: ref.scope, scopeId: ref.scopeId, key, value: parsed as object, changedBy },
        update: { value: parsed as object, changedBy, version: { increment: 1 } },
      });
      written.push(key);
    }
    return written;
  }

  static catalog(): {
    key: SettingKey;
    category: string;
    description: string;
    scopes: readonly SettingScope[];
    default: unknown;
  }[] {
    return (Object.keys(SETTINGS) as SettingKey[]).map((key) => ({
      key,
      category: SETTINGS[key].category,
      description: SETTINGS[key].description,
      scopes: SETTINGS[key].scopes,
      default: SETTINGS[key].default,
    }));
  }
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

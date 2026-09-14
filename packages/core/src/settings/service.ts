import { tenantTransaction } from "@aidp/db";
import {
  SECRET_SENTINEL,
  SETTINGS,
  isSecretSetting,
  parseSetting,
  settingDefault,
  type SettingKey,
  type SettingScope,
  type SettingValue,
} from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import type { Crypto } from "../crypto.js";

export interface SettingScopeRef {
  scope: SettingScope;
  scopeId: string; // "" for platform
}

/** Where an effective value came from; `null` means the catalog default. */
export interface ResolvedSetting {
  value: unknown;
  scope: SettingScope | null;
  scopeId: string;
}

/** Just enough of a logger to warn about an undecryptable row without depending on one. */
export interface SettingsLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Resolves the effective value of a setting: campaign > template > tenant > platform > catalog default.
 * Writes validate against the catalog and record who changed what (ADM knobs, FR-51).
 * Secret keys (contract 19) are encrypted at rest with the platform key: `get` and `resolveMany`
 * decrypt them for server-side use, `listAt` never returns anything but the sentinel.
 */
export class SettingsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly crypto: Crypto,
    private readonly log?: SettingsLogger,
  ) {}

  async get<K extends SettingKey>(key: K, chain: SettingScopeRef[]): Promise<SettingValue<K>> {
    const values = await this.resolveMany([key], chain);
    return values[key] as SettingValue<K>;
  }

  /** Effective values for many keys at once. `chain` is ordered most specific first. */
  async resolveMany(
    keys: SettingKey[],
    chain: SettingScopeRef[],
  ): Promise<Partial<Record<SettingKey, unknown>>> {
    const detailed = await this.resolveDetailed(keys, chain);
    const out: Partial<Record<SettingKey, unknown>> = {};
    for (const key of keys) out[key] = detailed[key]?.value;
    return out;
  }

  /** Like `resolveMany`, but says which scope supplied each value. */
  async resolveDetailed(
    keys: SettingKey[],
    chain: SettingScopeRef[],
  ): Promise<Partial<Record<SettingKey, ResolvedSetting>>> {
    const withPlatform = [
      ...chain.filter((c) => c.scope !== "platform"),
      { scope: "platform" as const, scopeId: "" },
    ];
    const rows = await this.db.setting.findMany({
      where: { key: { in: keys }, OR: withPlatform.map((c) => ({ scope: c.scope, scopeId: c.scopeId })) },
    });
    const out: Partial<Record<SettingKey, ResolvedSetting>> = {};
    for (const key of keys) {
      let resolved: ResolvedSetting = { value: settingDefault(key), scope: null, scopeId: "" };
      for (const ref of [...withPlatform].reverse()) {
        const row = rows.find((r) => r.key === key && r.scope === ref.scope && r.scopeId === ref.scopeId);
        if (!row || !SETTINGS[key].scopes.includes(ref.scope)) continue;
        const raw = this.readStored(key, row.value, ref);
        if (raw === undefined) continue;
        resolved = { value: parseSetting(key, raw), scope: ref.scope, scopeId: ref.scopeId };
      }
      out[key] = resolved;
    }
    return out;
  }

  /**
   * Raw values set at exactly one scope, for the admin editor. A secret that holds a value is
   * reported as the sentinel; `secrets` says which secret keys of this scope are set.
   */
  async describeAt(
    ref: SettingScopeRef,
  ): Promise<{ values: Partial<Record<SettingKey, unknown>>; secrets: Record<string, boolean> }> {
    const rows = await this.db.setting.findMany({ where: { scope: ref.scope, scopeId: ref.scopeId } });
    const values: Partial<Record<SettingKey, unknown>> = {};
    const secrets: Record<string, boolean> = {};
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      if (isSecretSetting(key) && SETTINGS[key].scopes.includes(ref.scope)) secrets[key] = false;
    }
    for (const r of rows) {
      if (!(r.key in SETTINGS)) continue;
      const key = r.key as SettingKey;
      if (!isSecretSetting(key)) {
        values[key] = r.value;
        continue;
      }
      const raw = this.readStored(key, r.value, ref);
      const set = typeof raw === "string" && raw.length > 0;
      secrets[key] = set;
      if (set) values[key] = SECRET_SENTINEL;
    }
    return { values, secrets };
  }

  /** Raw values set at exactly one scope, secrets masked. */
  async listAt(ref: SettingScopeRef): Promise<Partial<Record<SettingKey, unknown>>> {
    return (await this.describeAt(ref)).values;
  }

  /** Writes a batch of values at one scope. All of it lands or none of it does. */
  async set(
    ref: SettingScopeRef,
    values: Record<string, unknown>,
    changedBy: string | null,
  ): Promise<SettingKey[]> {
    return tenantTransaction(this.db, async (tx) => {
      const written: SettingKey[] = [];
      for (const [k, v] of Object.entries(values)) {
        if (!(k in SETTINGS)) throw new SettingsError(`Unknown setting '${k}'`);
        const key = k as SettingKey;
        if (!SETTINGS[key].scopes.includes(ref.scope))
          throw new SettingsError(`Setting '${key}' cannot be set at scope '${ref.scope}'`);
        if (v === null) {
          await tx.setting.deleteMany({ where: { scope: ref.scope, scopeId: ref.scopeId, key } });
          written.push(key);
          continue;
        }
        // The sentinel means "leave the stored secret alone", so nothing is written for it.
        if (isSecretSetting(key) && v === SECRET_SENTINEL) continue;
        const parsed = parseValue(key, v);
        const stored = isSecretSetting(key) ? this.crypto.encrypt(String(parsed)) : parsed;
        await tx.setting.upsert({
          where: { scope_scopeId_key: { scope: ref.scope, scopeId: ref.scopeId, key } },
          create: { scope: ref.scope, scopeId: ref.scopeId, key, value: stored as object, changedBy },
          update: { value: stored as object, changedBy, version: { increment: 1 } },
        });
        written.push(key);
      }
      return written;
    });
  }

  /**
   * Stored JSON to a usable value. A secret row is ciphertext; a key that has been rotated or a
   * corrupt row must not break the screen, so it is logged and treated as unset.
   */
  private readStored(key: SettingKey, value: unknown, ref: SettingScopeRef): unknown {
    if (!isSecretSetting(key)) return value;
    if (typeof value !== "string" || value.length === 0) return undefined;
    try {
      return this.crypto.decrypt(value);
    } catch {
      this.log?.warn("setting could not be decrypted; treating it as unset", {
        key,
        scope: ref.scope,
        scopeId: ref.scopeId,
      });
      return undefined;
    }
  }

  static catalog(): {
    key: SettingKey;
    category: string;
    description: string;
    scopes: readonly SettingScope[];
    default: unknown;
    secret: boolean;
  }[] {
    return (Object.keys(SETTINGS) as SettingKey[]).map((key) => ({
      key,
      category: SETTINGS[key].category,
      description: SETTINGS[key].description,
      scopes: SETTINGS[key].scopes,
      default: SETTINGS[key].default,
      secret: isSecretSetting(key),
    }));
  }
}

function parseValue(key: SettingKey, value: unknown): unknown {
  try {
    return parseSetting(key, value);
  } catch (e) {
    if (e instanceof ZodError)
      throw new SettingsError(`Invalid value for '${key}': ${e.issues.map((i) => i.message).join("; ")}`);
    throw e;
  }
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

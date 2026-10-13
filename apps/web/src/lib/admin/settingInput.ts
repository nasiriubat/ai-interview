import { FACTOR_KEYS, SETTINGS, type SettingKey } from "@aidp/shared";
import type { z } from "zod";

export type SettingInputKind =
  | { kind: "boolean" }
  | { kind: "number"; min?: number; max?: number; integer: boolean }
  | { kind: "enum"; values: string[] }
  | { kind: "list" }
  | { kind: "color" }
  | { kind: "secret" }
  /** A `Record<string, number>` such as `analysis.weights`: one number input per key. */
  | { kind: "weights"; keys: string[]; min?: number; max?: number }
  | { kind: "text" };

/** The keys of a record-valued setting: the default's own keys, else the shared factor keys. */
function recordKeys(defaultValue: unknown): string[] {
  if (defaultValue && typeof defaultValue === "object" && !Array.isArray(defaultValue)) {
    const keys = Object.keys(defaultValue);
    if (keys.length > 0) return keys;
  }
  return [...FACTOR_KEYS];
}

function enumValues(schema: z.ZodType): string[] | undefined {
  const def = (schema as { def?: { type?: string; entries?: Record<string, unknown> } }).def;
  if (def?.type === "enum" && def.entries) return Object.values(def.entries).map(String);
  return undefined;
}

function numberBounds(schema: z.ZodType): { min?: number; max?: number; integer: boolean } {
  const def: unknown = schema.def;
  const checks: unknown = typeof def === "object" && def !== null && "checks" in def ? def.checks : [];
  const out: { min?: number; max?: number; integer: boolean } = { integer: false };
  for (const c of Array.isArray(checks) ? (checks as { _zod?: { def?: Record<string, unknown> } }[]) : []) {
    const d = c._zod?.def ?? {};
    if (d.check === "greater_than" && typeof d.value === "number") out.min = d.value;
    if (d.check === "less_than" && typeof d.value === "number") out.max = d.value;
    if (d.check === "number_format" && d.format === "safeint") out.integer = true;
  }
  return out;
}

/**
 * Decides which input renders a setting. Keys known to the shared catalog use their zod
 * schema; unknown keys (a newer API) fall back to the type of the default value.
 */
export function settingInputKind(
  key: string,
  defaultValue: unknown,
  secret?: boolean | null,
): SettingInputKind {
  if (secret) return { kind: "secret" };
  const def = key in SETTINGS ? SETTINGS[key as SettingKey] : undefined;
  if (def) {
    const schema: z.ZodType = def.schema;
    const type = (schema as { def?: { type?: string } }).def?.type;
    if (type === "boolean") return { kind: "boolean" };
    if (type === "number") return { kind: "number", ...numberBounds(schema) };
    if (type === "enum") return { kind: "enum", values: enumValues(schema) ?? [] };
    if (type === "array") return { kind: "list" };
    if (type === "record") return { kind: "weights", keys: recordKeys(defaultValue), min: 0, max: 5 };
    if (key === "branding.primaryColor") return { kind: "color" };
    return { kind: "text" };
  }
  if (typeof defaultValue === "boolean") return { kind: "boolean" };
  if (typeof defaultValue === "number") return { kind: "number", integer: Number.isInteger(defaultValue) };
  if (Array.isArray(defaultValue)) return { kind: "list" };
  if (defaultValue && typeof defaultValue === "object") {
    return { kind: "weights", keys: recordKeys(defaultValue) };
  }
  return { kind: "text" };
}

/** Reads a `Record<string, number>` setting value, tolerating a missing or malformed entry. */
export function weightsValue(v: unknown, keys: string[]): Record<string, number> {
  const src = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = typeof src[k] === "number" ? src[k] : 1;
  return out;
}

export function displaySettingValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return typeof v === "object" ? JSON.stringify(v) : "";
}

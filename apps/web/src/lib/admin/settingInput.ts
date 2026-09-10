import { SETTINGS, type SettingKey } from "@aidp/shared";
import type { z } from "zod";

export type SettingInputKind =
  | { kind: "boolean" }
  | { kind: "number"; min?: number; max?: number; integer: boolean }
  | { kind: "enum"; values: string[] }
  | { kind: "list" }
  | { kind: "color" }
  | { kind: "text" };

function enumValues(schema: z.ZodType): string[] | undefined {
  const def = (schema as { def?: { type?: string; entries?: Record<string, unknown> } }).def;
  if (def?.type === "enum" && def.entries) return Object.values(def.entries).map(String);
  return undefined;
}

function numberBounds(schema: z.ZodType): { min?: number; max?: number; integer: boolean } {
  const def = (schema as unknown as { def?: { checks?: { _zod?: { def?: Record<string, unknown> } }[] } })
    .def;
  const out: { min?: number; max?: number; integer: boolean } = { integer: false };
  for (const c of def?.checks ?? []) {
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
export function settingInputKind(key: string, defaultValue: unknown): SettingInputKind {
  const def = key in SETTINGS ? SETTINGS[key as SettingKey] : undefined;
  if (def) {
    const schema: z.ZodType = def.schema;
    const type = (schema as { def?: { type?: string } }).def?.type;
    if (type === "boolean") return { kind: "boolean" };
    if (type === "number") return { kind: "number", ...numberBounds(schema) };
    if (type === "enum") return { kind: "enum", values: enumValues(schema) ?? [] };
    if (type === "array") return { kind: "list" };
    if (key === "branding.primaryColor") return { kind: "color" };
    return { kind: "text" };
  }
  if (typeof defaultValue === "boolean") return { kind: "boolean" };
  if (typeof defaultValue === "number") return { kind: "number", integer: Number.isInteger(defaultValue) };
  if (Array.isArray(defaultValue)) return { kind: "list" };
  return { kind: "text" };
}

export function displaySettingValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return typeof v === "object" ? JSON.stringify(v) : "";
}

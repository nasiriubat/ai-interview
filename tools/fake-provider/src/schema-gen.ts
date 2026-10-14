/**
 * The smallest value that satisfies a JSON schema.
 *
 * Structured calls (extraction, clustering, issue detection, report drafting, spec generation)
 * send their schema with the request, so the fake does not need to know each one: it reads the
 * schema and returns a value of the right shape. Arrays are empty unless the schema demands more,
 * strings are a short scripted phrase, numbers are the minimum. Where a pass needs content that
 * means something (facts out of a conversation), `brain.ts` fills it in before falling back here.
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = Record<string, unknown>;

const MAX_DEPTH = 12;

const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const asObj = (v: unknown): Schema => (isObject(v) ? v : {});

export function minimalValue(schema: unknown, root: unknown = schema, depth = 0): Json {
  if (depth > MAX_DEPTH || !isObject(schema)) return null;
  const s = schema;
  if (typeof s.$ref === "string") return minimalValue(resolveRef(s.$ref, root), root, depth + 1);
  if ("const" in s) return s.const as Json;
  const enumValues: unknown = s.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0] as Json;
  const union: unknown = s.anyOf ?? s.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    // Prefer a non-null member: a nullable field is better answered with a value.
    const members: unknown[] = union;
    const pick = members.find((m) => !(isObject(m) && m.type === "null")) ?? members[0];
    return minimalValue(pick, root, depth + 1);
  }
  const allOf: unknown = s.allOf;
  if (Array.isArray(allOf) && allOf.length > 0) {
    const merged: Schema = {};
    let properties: Schema = {};
    const required: string[] = [];
    for (const part of allOf as unknown[]) {
      const resolved = isObject(part) && typeof part.$ref === "string" ? resolveRef(part.$ref, root) : part;
      if (!isObject(resolved)) continue;
      Object.assign(merged, resolved);
      properties = { ...properties, ...asObj(resolved.properties) };
      const req: unknown = resolved.required;
      if (Array.isArray(req)) required.push(...(req as string[]));
    }
    return minimalValue({ ...merged, properties, required }, root, depth + 1);
  }
  if (s.default !== undefined && !isObject(s.default) && !Array.isArray(s.default)) return s.default as Json;
  const rawType: unknown = s.type;
  const type = Array.isArray(rawType)
    ? ((rawType as unknown[]).find((t) => t !== "null") ?? "null")
    : rawType;
  switch (type) {
    case "object": {
      const out: Record<string, Json> = {};
      const props = asObj(s.properties);
      const required = Array.isArray(s.required) ? (s.required as string[]) : [];
      for (const key of required) out[key] = minimalValue(props[key], root, depth + 1);
      return out;
    }
    case "array": {
      const min = typeof s.minItems === "number" ? s.minItems : 0;
      return Array.from({ length: min }, () => minimalValue(s.items, root, depth + 1));
    }
    case "string":
      return stringFor(s);
    case "integer":
    case "number": {
      // OpenAPI 3.0 spells an exclusive bound as `minimum` plus a boolean flag; draft 2020 as a number.
      const min =
        typeof s.exclusiveMinimum === "number"
          ? s.exclusiveMinimum + 1
          : typeof s.minimum === "number"
            ? s.minimum + (s.exclusiveMinimum === true ? 1 : 0)
            : 0;
      return type === "integer" ? Math.ceil(min) : min;
    }
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      // No type at all: z.unknown(). A short string is a legal value of anything that is "any".
      return "scripted";
  }
}

function stringFor(s: Schema): string {
  const format = typeof s.format === "string" ? s.format : "";
  if (format === "uuid") return "00000000-0000-4000-8000-000000000000";
  if (format === "email") return "scripted@example.test";
  if (format === "date-time") return new Date(0).toISOString();
  if (format === "date") return "1970-01-01";
  if (format === "uri" || format === "url") return "https://example.test/";
  let text = "scripted";
  const min = typeof s.minLength === "number" ? s.minLength : 0;
  while (text.length < min) text += " scripted";
  return text;
}

function resolveRef(ref: string, root: unknown): unknown {
  if (!ref.startsWith("#/")) return {};
  let cur: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isObject(cur)) return {};
    cur = cur[decodeURIComponent(part)];
  }
  return cur;
}

export interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: { role?: string; content?: unknown }[];
  response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } };
}

/** The schema the request carries: `response_format` when strict, else the instruction written into the prompt. */
export function schemaOfRequest(body: ChatBody): unknown {
  const fromFormat = body.response_format?.json_schema?.schema;
  if (fromFormat !== undefined) return fromFormat;
  for (const m of body.messages ?? []) {
    const text = contentText(m.content);
    const at = text.indexOf("matching this JSON schema exactly:");
    if (at < 0) continue;
    const rest = text.slice(at).split("\n").slice(1).join("\n").trim();
    try {
      return JSON.parse(rest);
    } catch {
      // A schema that does not parse is answered with `{}` by the caller.
    }
  }
  return undefined;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) => (isObject(p) && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

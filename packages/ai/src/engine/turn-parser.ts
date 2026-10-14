import { FactSchema, StateDeltaSchema, WidgetSchema, type StateDelta } from "@aidp/shared";
import { z } from "zod";

export const TURN_MARKER = "<<<TURN_META>>>";

/** The JSON the model appends after the marker. Lenient: every field optional, validated where present. */
export const TurnMetaSchema = z.object({
  areaKey: z.string().nullable().optional(),
  widget: WidgetSchema.nullable().optional(),
  voiceShortForm: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  endInterview: z.boolean().nullable().optional(),
  // Parsed separately and leniently by parseStateDelta: a bad field must not cost the whole delta.
  stateDelta: z.unknown().optional(),
});
export type TurnMeta = z.infer<typeof TurnMetaSchema>;

/** Removes null values recursively so a model's `null` reads as "absent" for optional fields. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

const SPEC_SOURCES = new Set(["user", "default_accepted", "recommended", "handoff"]);

/**
 * Parses a model-produced state delta without letting one bad field discard the rest:
 * nulls are dropped, invalid facts are dropped one by one (a spec_field with an unknown
 * source is kept as "user"), and any field that still fails validation is removed.
 * Returns the delta plus what was dropped, for the log.
 */
export function parseStateDelta(raw: unknown): { delta: StateDelta; dropped: string[] } {
  const dropped: string[] = [];
  const cleaned = stripNulls(raw);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned))
    return { delta: StateDeltaSchema.parse({}), dropped: raw === undefined ? [] : ["stateDelta"] };
  const obj = { ...(cleaned as Record<string, unknown>) };

  if (Array.isArray(obj.facts)) {
    obj.facts = (obj.facts as unknown[]).flatMap((f, i) => {
      let candidate: unknown = f;
      if (
        candidate &&
        typeof candidate === "object" &&
        (candidate as { kind?: unknown }).kind === "spec_field" &&
        !SPEC_SOURCES.has(String((candidate as { source?: unknown }).source))
      ) {
        candidate = { ...(candidate as Record<string, unknown>), source: "user" };
      }
      const r = FactSchema.safeParse(candidate);
      if (r.success) return [r.data];
      dropped.push(`facts[${i}]`);
      return [];
    });
  }

  const first = StateDeltaSchema.safeParse(obj);
  if (first.success) return { delta: first.data, dropped };
  // Remove every top-level field that failed, then parse what is left.
  const bad = new Set(first.error.issues.map((i) => String(i.path[0] ?? "")));
  for (const key of bad) if (key in obj) dropped.push(key);
  const second = StateDeltaSchema.safeParse(
    Object.fromEntries(Object.entries(obj).filter(([k]) => !bad.has(k))),
  );
  return second.success
    ? { delta: second.data, dropped }
    : { delta: StateDeltaSchema.parse({}), dropped: [...dropped, "stateDelta"] };
}

/**
 * The marker as a model actually writes it. The prompt asks for exactly `<<<TURN_META>>>`; models
 * drop a bracket, change case, add spaces, or write `TURN_META:` (29 turns of one live run lost
 * their state delta to that). Any of these start the metadata.
 */
const MARKER_VARIANT = /<{1,4}\s*TURN[_\- ]?META\s*>{0,4}|(?:^|\n)\s*\**TURN[_\- ]?META\**\s*[:=]/i;
/** A JSON object that is plainly the metadata, whether or not the marker came before it. */
const META_OBJECT_START = /\{\s*"(areaKey|stateDelta|widget|voiceShortForm|reason|endInterview)"\s*:/;
/** How much of a possible start is held back from the participant while it is still ambiguous. */
const HOLD_BACK = 24;

/**
 * Splits a streamed model response into the participant-facing message (emitted as it
 * arrives) and the trailing metadata JSON (parsed at the end). Holds back a small tail so a
 * partially received marker is never shown to the participant.
 *
 * Tolerant in two ways: marker variants (`<<TURN_META>>`, `turn_meta:`, spacing and case) are
 * accepted, and when there is no marker but the reply ends in the metadata object, that object is
 * taken as the metadata and removed from the message. A reply with no recoverable metadata comes
 * back with `error` set; the engine then asks for it separately (see `turn-repair.ts`).
 */
export class TurnParser {
  private buffer = "";
  private inMeta = false;
  private meta = "";
  private message = "";

  /** Feed a delta; returns the text safe to show now. */
  push(delta: string): string {
    if (this.inMeta) {
      this.meta += delta;
      return "";
    }
    this.buffer += delta;
    const found = this.findMetaStart(this.buffer);
    if (found) {
      const out = this.buffer.slice(0, found.start);
      this.meta = this.buffer.slice(found.end);
      this.buffer = "";
      this.inMeta = true;
      this.message += out;
      return out;
    }
    // Emit everything except a tail that could still turn out to be the start of the metadata.
    const keep = this.holdBack(this.buffer);
    const out = this.buffer.slice(0, this.buffer.length - keep);
    this.buffer = this.buffer.slice(this.buffer.length - keep);
    this.message += out;
    return out;
  }

  /** Where the metadata begins in `text`, and where its JSON begins: a marker variant, or a bare object. */
  private findMetaStart(text: string): { start: number; end: number } | undefined {
    const marker = MARKER_VARIANT.exec(text);
    if (marker) {
      // A match anchored on a newline starts after it.
      const start = marker.index + (marker[0].startsWith("\n") ? 1 : 0);
      return { start, end: marker.index + marker[0].length };
    }
    const obj = META_OBJECT_START.exec(text);
    if (obj) {
      // Include a code fence that opens the object, so it is not left in the message.
      const before = text.slice(0, obj.index);
      const fence = /(?:```[a-z]*\s*)$/i.exec(before);
      return { start: fence ? obj.index - fence[0].length : obj.index, end: obj.index };
    }
    return undefined;
  }

  /** The length of a tail that might be the beginning of a marker or of the metadata object. */
  private holdBack(text: string): number {
    const tail = text.slice(-HOLD_BACK);
    let keep = 0;
    // A possible partial marker: a `<` or the word TURN_META started within the tail.
    for (let i = 0; i < tail.length; i++) {
      const rest = tail.slice(i);
      if (/^<{1,4}\s*(T(U(R(N([_\- ]?(M(E(T(A\s*>{0,4})?)?)?)?)?)?)?)?)?\s*$/i.test(rest)) {
        keep = Math.max(keep, rest.length);
        break;
      }
      // A bare label (`TURN_META:`, `**TURN_META**:`) counts only at the start of a line:
      // mid-sentence words are not markers. The newline and any asterisks before it are held too.
      if (/^\s*\**(T(U(R(N([_\- ]?(M(E(T(A\**\s*)?)?)?)?)?)?)?)?)?$/i.test(rest)) {
        const pos = text.length - rest.length;
        const lineStart = pos === 0 || text[pos - 1] === "\n" || rest.startsWith("\n");
        if (lineStart) {
          keep = Math.max(keep, rest.length);
          break;
        }
      }
    }
    // A code fence at the very end may be about to open the metadata object.
    const fenceTail = /`{1,3}[a-z]*\s*$/i.exec(text);
    if (fenceTail) keep = Math.max(keep, fenceTail[0].length);
    // A possible start of the metadata object: a `{` (optionally after a fence) that is not yet decided.
    const brace = text.lastIndexOf("{");
    if (brace >= 0 && text.length - brace <= 48) {
      const after = text.slice(brace);
      const decided = META_OBJECT_START.test(after) || !/^\{\s*("[a-zA-Z]*"?\s*:?)?$/.test(after);
      if (!decided) {
        const before = text.slice(0, brace);
        const fence = /(?:```[a-z]*\s*)$/i.exec(before);
        keep = Math.max(keep, text.length - brace + (fence ? fence[0].length : 0));
      }
    }
    return Math.min(keep, text.length);
  }

  /** Call once the stream ends. Returns the final message and parsed metadata (or a parse error). */
  finish(): { message: string; meta: TurnMeta; rest: string; error?: string } {
    if (!this.inMeta) {
      // Nothing matched while streaming. Whatever was held back is part of the message unless it
      // is itself the whole metadata object (a reply that is only JSON).
      const tail = this.buffer;
      this.buffer = "";
      const found = this.findMetaStart(tail);
      if (found) {
        this.message += tail.slice(0, found.start);
        this.meta = tail.slice(found.end);
        this.inMeta = true;
      } else {
        this.message += tail;
        return { message: this.message.trimEnd(), meta: {}, rest: tail, error: "missing marker" };
      }
    }
    const json = extractJsonObject(this.meta);
    if (!json) return { message: this.message.trimEnd(), meta: {}, rest: "", error: "no JSON after marker" };
    let raw: unknown;
    try {
      raw = stripNullsShallow(JSON.parse(json));
    } catch (e) {
      return {
        message: this.message.trimEnd(),
        meta: {},
        rest: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    const parsed = TurnMetaSchema.safeParse(raw);
    if (parsed.success) return { message: this.message.trimEnd(), meta: parsed.data, rest: "" };
    // A bad field costs that field, not the turn: drop the ones that failed and keep the rest, so a
    // malformed widget no longer takes the state delta down with it.
    const bad = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")));
    const kept = TurnMetaSchema.safeParse(
      Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).filter(([k]) => !bad.has(k))),
    );
    return {
      message: this.message.trimEnd(),
      meta: kept.success ? kept.data : {},
      rest: "",
      error: `invalid metadata field(s): ${[...bad].join(", ") || "unknown"}`,
    };
  }
}

/** Top-level nulls only: the state delta is cleaned by parseStateDelta, the widget must stay as sent. */
function stripNullsShallow(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null));
}

/** Finds the first balanced JSON object in a string, tolerating code fences and trailing text. */
export function extractJsonObject(s: string): string | undefined {
  const start = s.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

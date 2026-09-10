import { StateDeltaSchema, WidgetSchema } from "@aidp/shared";
import { z } from "zod";

export const TURN_MARKER = "<<<TURN_META>>>";

/** The JSON the model appends after the marker. Lenient: every field optional, validated where present. */
export const TurnMetaSchema = z.object({
  areaKey: z.string().nullable().optional(),
  widget: WidgetSchema.nullable().optional(),
  voiceShortForm: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  endInterview: z.boolean().nullable().optional(),
  stateDelta: StateDeltaSchema.optional(),
});
export type TurnMeta = z.infer<typeof TurnMetaSchema>;

/**
 * Splits a streamed model response into the participant-facing message (emitted as it
 * arrives) and the trailing metadata JSON (parsed at the end). Holds back a small tail so a
 * partially received marker is never shown to the participant.
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
    const idx = this.buffer.indexOf(TURN_MARKER);
    if (idx >= 0) {
      const out = this.buffer.slice(0, idx);
      this.meta = this.buffer.slice(idx + TURN_MARKER.length);
      this.buffer = "";
      this.inMeta = true;
      this.message += out;
      return out;
    }
    // Emit everything except a tail that could be the start of the marker.
    const keep = longestMarkerPrefixSuffix(this.buffer);
    const out = this.buffer.slice(0, this.buffer.length - keep);
    this.buffer = this.buffer.slice(this.buffer.length - keep);
    this.message += out;
    return out;
  }

  /** Call once the stream ends. Returns the final message and parsed metadata (or a parse error). */
  finish(): { message: string; meta: TurnMeta; rest: string; error?: string } {
    if (!this.inMeta) {
      this.message += this.buffer;
      const rest = this.buffer;
      this.buffer = "";
      return { message: this.message.trimEnd(), meta: {}, rest, error: "missing marker" };
    }
    const json = extractJsonObject(this.meta);
    if (!json) return { message: this.message.trimEnd(), meta: {}, rest: "", error: "no JSON after marker" };
    try {
      const parsed = TurnMetaSchema.parse(JSON.parse(json));
      return { message: this.message.trimEnd(), meta: parsed, rest: "" };
    } catch (e) {
      return {
        message: this.message.trimEnd(),
        meta: {},
        rest: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

function longestMarkerPrefixSuffix(s: string): number {
  const max = Math.min(TURN_MARKER.length - 1, s.length);
  for (let len = max; len > 0; len--) {
    if (s.endsWith(TURN_MARKER.slice(0, len))) return len;
  }
  return 0;
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

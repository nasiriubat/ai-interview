/*
 * "Listen to the question" (D-76): the browser's own speech synthesis. No server, no model, no
 * key, nothing leaves the device. These are the pure parts, kept apart from the hook so they can
 * be tested without a browser.
 */

/** Plain spoken text: markup that would be read aloud as symbols is removed. */
export function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|~]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sentence-sized pieces. Chrome silently stops an utterance after about fifteen seconds, so a long
 * question is queued as several short ones; a sentence longer than `max` is cut at a comma or a
 * space so no single piece runs past it.
 */
export function chunkForSpeech(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  for (const raw of sentences) {
    let s = raw.trim();
    while (s.length > max) {
      const window = s.slice(0, max);
      const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf(" "));
      const at = cut > max / 2 ? cut + 1 : max;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

interface VoiceLike {
  lang: string;
  name: string;
  localService?: boolean;
  default?: boolean;
}

/**
 * The best installed voice for a language: an exact regional match over a bare language match,
 * and among those the ones platforms mark as higher quality ("Natural", "Enhanced", "Premium",
 * Google's online voices) over the robotic defaults. Null when nothing speaks the language, in
 * which case the button is not offered rather than reading Finnish with an English voice.
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], locale: string): V | null {
  const want = locale.toLowerCase();
  const base = want.split("-")[0] ?? want;
  const candidates = voices.filter((v) => v.lang.toLowerCase().replace("_", "-").split("-")[0] === base);
  if (candidates.length === 0) return null;
  const score = (v: V): number => {
    const lang = v.lang.toLowerCase().replace("_", "-");
    let s = 0;
    if (lang === want || (want === base && lang.startsWith(`${base}-`))) s += 4;
    if (/natural|enhanced|premium|neural|google/i.test(v.name)) s += 3;
    if (v.default) s += 1;
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0] ?? null;
}

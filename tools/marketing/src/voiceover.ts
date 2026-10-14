/**
 * Turns a voice-over script (marketing/voiceover/script*.txt) into the plain text for a narrator
 * or a TTS engine and a SubRip file whose cues follow the scene timings.
 *
 *   pnpm --filter @aidp/marketing voiceover ../../marketing/voiceover/script.txt
 *
 * writes script.srt and script-plain.txt beside it (a "-60s" script gets its .srt only).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Scene {
  start: number;
  end: number;
  shot: string;
  text: string;
}

const CUE = /\[(?:pause [\d.]+s|beat)\]|\((?:slower|warm)\)|\*/g;

/** Scenes from a script: a "SCENE n  mm:ss-mm:ss  [file]" line followed by its text. */
export function parseScript(source: string): Scene[] {
  const scenes: Scene[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^SCENE \d+\s+(\d+):(\d+)-(\d+):(\d+)\s+\[([^\]]+)\]/.exec(lines[i] ?? "");
    if (!m) continue;
    const body: string[] = [];
    for (i++; i < lines.length && (lines[i] ?? "").trim() !== ""; i++) body.push((lines[i] ?? "").trim());
    i--;
    scenes.push({
      start: Number(m[1]) * 60 + Number(m[2]),
      end: Number(m[3]) * 60 + Number(m[4]),
      shot: m[5] ?? "",
      text: body.join(" "),
    });
  }
  return scenes;
}

/** The words a person hears: performance cues removed, spacing tidied. */
export function plain(text: string): string {
  return text
    .replace(CUE, "")
    .replace(/\s+([,.?!:;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

/**
 * SubRip cues: each scene's sentences share its time in proportion to their length, so a cue
 * never runs past its scene and the last cue ends when the scene does.
 */
export function toSrt(scenes: readonly Scene[]): string {
  const cues: string[] = [];
  let n = 1;
  for (const sc of scenes) {
    const sentences = plain(sc.text)
      .match(/[^.?!]+[.?!]+/g)
      ?.map((x) => x.trim()) ?? [plain(sc.text)];
    const total = sentences.reduce((a, x) => a + x.length, 0) || 1;
    let t = sc.start;
    for (const sentence of sentences) {
      const end = Math.min(sc.end, t + ((sc.end - sc.start) * sentence.length) / total);
      cues.push(`${String(n++)}\n${stamp(t)} --> ${stamp(end)}\n${sentence}\n`);
      t = end;
    }
  }
  return cues.join("\n");
}

const file = process.argv[2];
const main = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main && file) {
  const scenes = parseScript(readFileSync(file, "utf8"));
  const base = file.replace(/\.txt$/, "");
  writeFileSync(`${base}.srt`, toSrt(scenes));
  if (!base.endsWith("-60s"))
    writeFileSync(`${base}-plain.txt`, scenes.map((s) => plain(s.text)).join("\n\n") + "\n");
  console.log(`${String(scenes.length)} scenes, ${String(scenes.at(-1)?.end ?? 0)} s`);
}

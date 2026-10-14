import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseScript, plain, toSrt } from "../src/voiceover.js";

const read = (path: string): string =>
  readFileSync(new URL(`../../../marketing/${path}`, import.meta.url), "utf8");

describe("voice-over scripts", () => {
  it("strips performance cues for the narrator", () => {
    expect(plain("(warm) Hello, [pause 0.4s] *world* [beat] again.")).toBe("Hello, world again.");
  });

  it.each(["script.txt", "script-60s.txt"])("%s: scenes are contiguous and name a screenshot", (name) => {
    const scenes = parseScript(read(`voiceover/${name}`));
    expect(scenes.length).toBeGreaterThan(3);
    expect(scenes[0]?.start).toBe(0);
    for (let i = 1; i < scenes.length; i++) expect(scenes[i]?.start).toBe(scenes[i - 1]?.end);
    for (const s of scenes) {
      expect(s.shot).toMatch(/^\d{2}-[a-z0-9-]+\.png$/);
      expect(read("screenshots/index.md")).toContain(s.shot);
    }
    if (name === "script-60s.txt") expect(scenes.at(-1)?.end).toBe(60);
  });

  it.each(["script.txt", "script-60s.txt"])("%s: the committed .srt is what the script produces", (name) => {
    const srt = toSrt(parseScript(read(`voiceover/${name}`)));
    expect(read(`voiceover/${name.replace(/\.txt$/, ".srt")}`)).toBe(srt);
    expect(srt).toMatch(/^1\n00:00:00,000 --> /);
  });

  it("makes only claims the claims inventory allows (docs/team/claims-2026-10.md)", () => {
    const text = [
      ...parseScript(read("voiceover/script.txt")),
      ...parseScript(read("voiceover/script-60s.txt")),
    ]
      .map((s) => plain(s.text))
      .join(" ");
    for (const re of [
      /\bSSO\b/,
      /\bSlack\b/,
      /GDPR[- ]compliant/i,
      /\bguarantee/i,
      /stays in the EU/i,
      /\bGitHub\b/,
      /\d+ minutes/i,
    ])
      expect(text).not.toMatch(re);
  });
});

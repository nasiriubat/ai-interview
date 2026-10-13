import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { promptVersionTag, SHIPPED_PROMPTS } from "../../src/engine/prompts/index.js";

/**
 * A prompt body is pinned to its version (AGENTS.md rule 6, plan 3.6).
 *
 * The version is what the ledger and `Fact.extractorVersion` record, so a body that changes under
 * an unchanged version makes every historical number ambiguous: nothing can say which wording
 * produced a fact. This test makes that impossible to do by accident. Editing a prompt body fails
 * here until its version is bumped; bumping the version fails here until the new pin is recorded,
 * which is deliberate friction, since rule 6 also requires the evals to run at that point.
 *
 * To record pins after a deliberate change:
 *
 *     UPDATE_PROMPT_PINS=1 pnpm --filter @aidp/ai exec vitest run test/engine/prompt-pins.test.ts
 *
 * Old versions stay in the file once a newer one ships (history is append-only), marked retired.
 */

const PIN_FILE = fileURLToPath(new URL("./prompt-pins.json", import.meta.url));

interface Pin {
  sha256: string;
  retired?: true;
}

const normalize = (body: string): string =>
  body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trimEnd();

const hash = (body: string): string => createHash("sha256").update(normalize(body)).digest("hex");

const shipped = (): Record<string, { key: string; version: number; sha256: string }> =>
  Object.fromEntries(
    Object.values(SHIPPED_PROMPTS).map((p) => [
      promptVersionTag(p),
      { key: p.key, version: p.version, sha256: hash(p.body) },
    ]),
  );

const readPins = (): Record<string, Pin> => JSON.parse(readFileSync(PIN_FILE, "utf8")) as Record<string, Pin>;

describe("prompt pins", () => {
  if (process.env.UPDATE_PROMPT_PINS === "1") {
    it("rewrites the pin file", () => {
      const current = shipped();
      const previous = readPins();
      const next: Record<string, Pin> = {};
      // A version that no longer ships is kept, retired: history is append-only.
      for (const [tag, pin] of Object.entries(previous)) next[tag] = { ...pin, retired: true };
      for (const [tag, c] of Object.entries(current)) next[tag] = { sha256: c.sha256 };
      writeFileSync(
        PIN_FILE,
        `${JSON.stringify(Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`,
      );
    });
    return;
  }

  it("pins every shipped prompt, and nothing changed without a version bump", () => {
    const pins = readPins();
    for (const [tag, now] of Object.entries(shipped())) {
      const pin = pins[tag];
      expect(pin, `${tag} is not pinned: record it (see the comment at the top of this file)`).toBeDefined();
      expect(
        pin?.sha256,
        `${tag}: the prompt body changed but its version did not. Bump \`version\`, then re-pin.`,
      ).toBe(now.sha256);
    }
  });

  it("never lets a version go backwards or a pinned shipped version vanish", () => {
    const pins = readPins();
    for (const p of Object.values(SHIPPED_PROMPTS)) {
      for (const tag of Object.keys(pins)) {
        const [key, version] = tag.split("@");
        if (key === p.key)
          expect(
            p.version,
            `${p.key} ships version ${p.version} but ${tag} is already pinned`,
          ).toBeGreaterThanOrEqual(Number(version));
      }
    }
  });

  it("does not pin a prompt that no longer ships unless it is retired", () => {
    const current = shipped();
    for (const [tag, pin] of Object.entries(readPins())) {
      if (!current[tag]) expect(pin.retired, `${tag} is pinned but not shipped; mark it retired`).toBe(true);
    }
  });

  it("a different body produces a different hash (the pin is actually sensitive)", () => {
    expect(hash("a")).not.toBe(hash("b"));
    expect(hash("a  \r\n")).toBe(hash("a"));
  });
});

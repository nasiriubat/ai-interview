import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_EVENT_TYPES, ModeSwitchEventSchema, ControlEventSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next" || name === "test") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/**
 * The session event log has a closed set of types (D-179). The type system already refuses a
 * misspelt literal at a typed call site; this reads the source for the places that write the table
 * with a free string (`type: "..."` on a `sessionEvent.create`), which the type system cannot see.
 */
describe("session event types", () => {
  const files = ["apps", "packages"].flatMap((d) =>
    readdirSync(join(root, d)).flatMap((p) => {
      const src = join(root, d, p, "src");
      try {
        return sources(src);
      } catch {
        return [];
      }
    }),
  );

  it("are the only literals appendEvent is called with", () => {
    const used = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/appendEvent\(\s*[^,()]+,\s*"([^"]+)"/g)) used.add(m[1] ?? "");
    }
    expect(used.size).toBeGreaterThan(5);
    for (const type of used) expect(SESSION_EVENT_TYPES, type).toContain(type);
  });

  it("are the only literals written directly to the table", () => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/sessionEvent\.create\(\{[\s\S]{0,300}?type:\s*"([^"]+)"/g))
        expect(SESSION_EVENT_TYPES, `${f}: ${m[1]}`).toContain(m[1]);
    }
  });

  it("lists every type once", () => {
    expect(new Set(SESSION_EVENT_TYPES).size).toBe(SESSION_EVENT_TYPES.length);
    // The name live voice has always written under; a rename would orphan its rows.
    expect(SESSION_EVENT_TYPES).toContain("voice.live");
  });

  it("describes the payloads of the types added with controls and mode switches", () => {
    expect(
      ModeSwitchEventSchema.safeParse({ from: "chat", to: "voice", reason: "participant" }).success,
    ).toBe(true);
    expect(
      ModeSwitchEventSchema.safeParse({ from: "chat", to: "telepathy", reason: "participant" }).success,
    ).toBe(false);
    expect(ControlEventSchema.safeParse({ kind: "skip_area", areaKey: "tools", afterSeq: 4 }).success).toBe(
      true,
    );
  });
});

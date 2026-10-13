import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { DICTIONARIES, type Locale } from "@/i18n";
import { settingInputKind } from "@/lib/admin/settingInput";
import { ENUMS, labelIn, settingTextIn, settingValueLabelIn, type EnumKind } from "@/lib/i18n/enums";

const LOCALES = Object.keys(DICTIONARIES) as Locale[];
const KINDS = Object.keys(ENUMS) as EnumKind[];

describe("enum labels (D-132)", () => {
  it.each(LOCALES)("every member of every shared enum has a %s label", (locale) => {
    const strings = DICTIONARIES[locale];
    const missing: string[] = [];
    for (const kind of KINDS) {
      for (const member of ENUMS[kind].members) {
        const text = labelIn(strings, kind, member);
        if (text === undefined || text.trim() === "") missing.push(`${kind}.${member}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers the enums the admin renders", () => {
    // A guard against the registry being emptied: these are the kinds the screens read.
    for (const kind of ["purpose", "providerKind", "effort", "budgetScope", "solutionClass"] as const) {
      expect(ENUMS[kind].members.length).toBeGreaterThan(0);
    }
  });

  it("does not leave a Finnish label identical to its English one where the word is not a name", () => {
    // Proper names (Anthropic, OpenAI, ...) are allowed to match; everything else must be translated.
    const names = new Set(["anthropic", "openai", "openrouter", "ntfy", "slack", "codex", "claude_code"]);
    const same: string[] = [];
    for (const kind of KINDS) {
      for (const member of ENUMS[kind].members) {
        if (names.has(member)) continue;
        const en = labelIn(DICTIONARIES.en, kind, member);
        const fi = labelIn(DICTIONARIES.fi, kind, member);
        if (en !== undefined && en === fi) same.push(`${kind}.${member}=${en}`);
      }
    }
    // "Medium" and "Standard"-style words legitimately match in a few places; the list must stay short.
    expect(same.length).toBeLessThan(6);
  });

  it("names the coverage areas and background questions of the shipped templates", () => {
    const dir = join(__dirname, "../../../packages/db/src/seed-templates");
    const missing: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const tpl = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        coverageAreas?: { key: string }[];
        contextBlock?: { key: string }[];
      };
      for (const locale of LOCALES) {
        for (const a of tpl.coverageAreas ?? []) {
          if (labelIn(DICTIONARIES[locale], "coverageArea", a.key) === undefined)
            missing.push(`${locale}:${file}:area:${a.key}`);
        }
        for (const c of tpl.contextBlock ?? []) {
          if (labelIn(DICTIONARIES[locale], "contextKey", c.key) === undefined)
            missing.push(`${locale}:${file}:context:${c.key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("returns an unnamed identifier as itself, never reworded", () => {
    expect(labelIn(DICTIONARIES.en, "purpose", "brand_new_purpose")).toBeUndefined();
    expect(labelIn(DICTIONARIES.en, "purpose", "constructor")).toBeUndefined();
  });
});

describe("settings catalog labels", () => {
  const keys = Object.keys(SETTINGS);

  it.each(LOCALES)("every catalog key has a %s name and description", (locale) => {
    const strings = DICTIONARIES[locale];
    const missing = keys.filter((k) => {
      const text = settingTextIn(strings, k);
      return !text || text.label.trim() === "" || text.description.trim() === "";
    });
    expect(missing).toEqual([]);
  });

  it.each(LOCALES)("has no %s label for a key the catalog no longer has", (locale) => {
    const known = new Set(keys);
    const stale = Object.keys(DICTIONARIES[locale].enums.settingKey).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  it.each(LOCALES)("every option of an enum-valued setting has a %s label", (locale) => {
    const strings = DICTIONARIES[locale];
    const missing: string[] = [];
    for (const [key, def] of Object.entries(SETTINGS)) {
      const kind = settingInputKind(key, def.default, def.secret);
      if (kind.kind !== "enum") continue;
      for (const value of kind.values) {
        if (settingValueLabelIn(strings, key, value) === undefined) missing.push(`${key}=${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("does not show an identifier as a Finnish name", () => {
    const fi = DICTIONARIES.fi.enums.settingKey as Record<string, { label: string }>;
    const raw = keys.filter((k) => fi[k]?.label === k || fi[k]?.label === k.split(".").pop());
    expect(raw).toEqual([]);
  });
});

describe("humanize is not a labelling strategy (D-132)", () => {
  const root = join(__dirname, "../src");

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }

  it("is called nowhere in the app: identifiers go through label(kind, value)", () => {
    const offenders: string[] = [];
    for (const file of files(root)) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      if (/\bhumanize\b/.test(code)) offenders.push(file.slice(root.length));
    }
    expect(offenders).toEqual([]);
  });
});

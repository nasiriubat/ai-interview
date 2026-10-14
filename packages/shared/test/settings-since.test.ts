import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CURRENT_RELEASE,
  DEFAULT_CONSENT_TEXT,
  RELEASES,
  SETTINGS,
  defaultConsentText,
  isOperatorOnlySetting,
  settingDefault,
  type SettingKey,
} from "../src/index.js";

const baseline = (
  JSON.parse(readFileSync(new URL("./settings-baseline.json", import.meta.url), "utf8")) as {
    keys: string[];
  }
).keys;
const keys = Object.keys(SETTINGS) as SettingKey[];
const sinceOf = (k: SettingKey): string | undefined => (SETTINGS[k] as { since?: string }).since;

describe("settings `since` (D-180)", () => {
  it("refuses a key that is neither in the baseline nor carries a known release", () => {
    const untracked = keys.filter((k) => !baseline.includes(k) && sinceOf(k) === undefined);
    expect(untracked).toEqual([]);
  });

  it("names only known releases, and the current one is the newest", () => {
    for (const k of keys) {
      const since = sinceOf(k);
      if (since !== undefined) expect(RELEASES as readonly string[]).toContain(since);
    }
    expect(RELEASES[RELEASES.length - 1]).toBe(CURRENT_RELEASE);
  });

  it("keeps the baseline honest: every baseline key still exists or is a deliberate removal", () => {
    // A removed key leaves the baseline stale but harmless; this only guards typos that would
    // let a new key slip through by matching a name nobody ever had.
    const removed = new Set(["features.collaboration", "branding.primaryColor"]);
    const unknown = baseline.filter((k) => !(k in SETTINGS) && !removed.has(k));
    expect(unknown).toEqual([]);
  });
});

describe("operator-only settings (D-188)", () => {
  it("marks exactly the ceilings", () => {
    const marked = keys.filter(isOperatorOnlySetting);
    expect(marked.length).toBeGreaterThan(0);
    for (const k of marked) expect(k.startsWith("ceiling.")).toBe(true);
    expect(keys.filter((k) => k.startsWith("ceiling.")).sort()).toEqual([...marked].sort());
  });

  it("lets a ceiling be set at tenant scope but never at template or campaign scope", () => {
    for (const k of keys.filter((k) => k.startsWith("ceiling."))) {
      expect(SETTINGS[k].scopes).toContain("tenant");
      expect(SETTINGS[k].scopes).not.toContain("campaign");
    }
  });
});

describe("the default consent text (D-185)", () => {
  it("is Finnish for a Finnish interview and English for everything else", () => {
    expect(defaultConsentText("fi")).toBe(DEFAULT_CONSENT_TEXT.fi);
    expect(defaultConsentText("fi-FI")).toBe(DEFAULT_CONSENT_TEXT.fi);
    expect(defaultConsentText("en")).toBe(DEFAULT_CONSENT_TEXT.en);
    expect(defaultConsentText("sv")).toBe(DEFAULT_CONSENT_TEXT.en);
    expect(defaultConsentText(undefined)).toBe(DEFAULT_CONSENT_TEXT.en);
  });

  it("is the catalog default in English, so a stored value never has to match the Finnish one", () => {
    expect(settingDefault("campaign.consentText")).toBe(DEFAULT_CONSENT_TEXT.en);
  });

  it("promises only what deletion does: answers, recordings and files, and no deletion email", () => {
    for (const text of Object.values(DEFAULT_CONSENT_TEXT)) {
      expect(text).not.toMatch(/confirmation|vahvistus|sähköpost|email you/i);
    }
    expect(DEFAULT_CONSENT_TEXT.en).toMatch(/answers, recordings and files/);
    expect(DEFAULT_CONSENT_TEXT.fi).toMatch(/vastauksesi, tallenteesi ja tiedostosi/);
  });
});

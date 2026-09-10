import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  InterviewTemplateSchema,
  SETTINGS,
  TurnObjectSchema,
  parseSetting,
  settingKeysForScope,
  widgetResponseToText,
} from "../src/index.js";

const seed = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../db/seeds/templates/${name}.json`, import.meta.url), "utf8"));

describe("seeded templates", () => {
  it.each(["opportunity_discovery", "requirements_discovery"])(
    "%s validates against the template schema",
    (name) => {
      const t = InterviewTemplateSchema.parse(seed(name));
      expect(t.coverageAreas.length).toBeGreaterThan(3);
      expect(new Set(t.coverageAreas.map((a) => a.key)).size).toBe(t.coverageAreas.length);
    },
  );
});

describe("turn object", () => {
  it("applies defaults and rejects an empty message", () => {
    const t = TurnObjectSchema.parse({ message: "What does a typical morning look like?" });
    expect(t.stateDelta.facts).toEqual([]);
    expect(() => TurnObjectSchema.parse({ message: "" })).toThrow();
  });
});

describe("widgets", () => {
  it("renders responses as text with labels and Other", () => {
    const w = {
      type: "multi_choice" as const,
      options: [
        { key: "a", label: "Email" },
        { key: "b", label: "Excel" },
      ],
    };
    expect(
      widgetResponseToText(w, { type: "multi_choice", keys: ["a", "b"], other: "a homegrown tool" }),
    ).toBe("Email, Excel, a homegrown tool");
  });
});

describe("settings catalog", () => {
  it("every default satisfies its own schema", () => {
    for (const key of Object.keys(SETTINGS) as (keyof typeof SETTINGS)[]) {
      expect(() => parseSetting(key, SETTINGS[key].default)).not.toThrow();
    }
  });
  it("filters keys by scope", () => {
    expect(settingKeysForScope("campaign")).toContain("campaign.consentText");
    expect(settingKeysForScope("campaign")).not.toContain("privacy.kAnonymity");
  });
});

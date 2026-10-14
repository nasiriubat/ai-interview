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
  JSON.parse(readFileSync(new URL(`../../db/src/seed-templates/${name}.json`, import.meta.url), "utf8"));

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

describe("the legacy completion sentinel", () => {
  it("is migrated to finishRequested and no longer counts as a turn count (D-170)", async () => {
    const { COMPLETION_REQUESTED_TURN_COUNT, SessionStateSchema } = await import("../src/index.js");
    const parsed = SessionStateSchema.parse({
      turnCount: COMPLETION_REQUESTED_TURN_COUNT,
      lastWidgetTurn: 4,
    });
    expect(parsed.finishRequested).toBe(true);
    expect(parsed.turnCount).toBe(4);
    const fresh = SessionStateSchema.parse({ turnCount: 7 });
    expect(fresh.finishRequested).toBe(false);
    expect(fresh.turnCount).toBe(7);
  });
  it("parses a turn control and rejects an unknown one or a missing area", async () => {
    const { TurnControlSchema } = await import("../src/index.js");
    expect(TurnControlSchema.safeParse({ type: "finish" }).success).toBe(true);
    expect(TurnControlSchema.safeParse({ type: "skip_area", areaKey: "tools" }).success).toBe(true);
    expect(TurnControlSchema.safeParse({ type: "skip_area" }).success).toBe(false);
    expect(TurnControlSchema.safeParse({ type: "explode" }).success).toBe(false);
  });
});

describe("the completion sentinel", () => {
  it("is a valid turn count, not the -1 a 32-bit shift of MAX_SAFE_INTEGER produces", async () => {
    const { COMPLETION_REQUESTED_TURN_COUNT, SessionStateSchema } = await import("../src/index.js");
    expect(COMPLETION_REQUESTED_TURN_COUNT).toBeGreaterThan(1000);
    expect(Number.isInteger(COMPLETION_REQUESTED_TURN_COUNT)).toBe(true);
    const parsed = SessionStateSchema.safeParse({ turnCount: COMPLETION_REQUESTED_TURN_COUNT });
    expect(parsed.success).toBe(true);
    // The value the code used to write cannot be stored: this is the regression.
    expect(Number.MAX_SAFE_INTEGER >> 1).toBe(-1);
    expect(SessionStateSchema.safeParse({ turnCount: Number.MAX_SAFE_INTEGER >> 1 }).success).toBe(false);
  });
});

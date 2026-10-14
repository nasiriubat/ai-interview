import { describe, expect, it } from "vitest";
import {
  DEFAULT_WELCOME_TEXT,
  defaultWelcomeText,
  participantWelcome,
  SETTINGS,
  welcomeKindOf,
} from "../src/settings.js";

/* The participant welcome (D-460, D-461): never the template objective, which is for the AI. */
describe("participant welcome", () => {
  it("is a campaign-scoped catalog key with a release", () => {
    const def = SETTINGS["campaign.welcomeText"];
    expect(def.scopes).toEqual(["campaign"]);
    expect(def.since).toBe("2026.10");
    expect(def.schema.safeParse("   ").success).toBe(false);
  });

  it("tells requirements templates from discovery ones", () => {
    expect(welcomeKindOf({ key: "requirements_discovery" })).toBe("requirements");
    expect(welcomeKindOf({ key: "custom", issueDetection: { enabled: true } })).toBe("requirements");
    expect(welcomeKindOf({ key: "opportunity_discovery", issueDetection: { enabled: false } })).toBe(
      "discovery",
    );
    expect(welcomeKindOf({ key: "anything" })).toBe("discovery");
  });

  it("speaks the interview language, English for anything but Finnish", () => {
    expect(defaultWelcomeText("discovery", "fi-FI")).toBe(DEFAULT_WELCOME_TEXT.discovery.fi);
    expect(defaultWelcomeText("requirements", "sv")).toBe(DEFAULT_WELCOME_TEXT.requirements.en);
  });

  it("uses a saved text trimmed, and the default for a blank or missing one", () => {
    const tpl = { key: "opportunity_discovery", language: "en" };
    expect(participantWelcome("  Our words. ", tpl)).toBe("Our words.");
    expect(participantWelcome("  ", tpl)).toBe(DEFAULT_WELCOME_TEXT.discovery.en);
    expect(participantWelcome(null, { ...tpl, language: "fi" })).toBe(DEFAULT_WELCOME_TEXT.discovery.fi);
  });

  it("defaults say nothing about AI opportunities and promise only built behaviour", () => {
    for (const kind of Object.values(DEFAULT_WELCOME_TEXT))
      for (const text of Object.values(kind)) {
        expect(text).not.toMatch(/\bAI\b|automat|tekoäly/i);
        expect(text.length).toBeLessThan(500);
      }
  });
});

describe("code requests from one office address (D-468)", () => {
  it("lets a typical office ask for codes without hitting the per-address cap", () => {
    const def = SETTINGS["abuse.distinctEmailsPerAddressPerHour"];
    expect(def.default).toBeGreaterThanOrEqual(50);
    expect(def.schema.safeParse(500).success).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { switchEnabled, tenantInvitationEmail, voiceAllowed } from "../src/index.js";

/** A settings stand-in that answers with the values a test lists, most specific first. */
const settings = (voiceEnabled: unknown[], flags: Record<string, boolean> = {}) => ({
  valuesAcrossScopes: async () => voiceEnabled,
  get: async (key: string) => flags[key] ?? true,
});

describe("switchEnabled (D-186)", () => {
  const cases: [string, unknown[], boolean][] = [
    ["nobody set it: the catalog default, which is on", [], true],
    ["only the template turned it off", [false], false],
    ["tenant off, template on: off, a template cannot widen", [true, false], false],
    ["tenant on, template off: off", [false, true], false],
    ["every level on", [true, true], true],
  ];
  for (const [name, values, expected] of cases) {
    it(name, async () => {
      expect(await switchEnabled(settings(values) as never, "voice.enabled", [])).toBe(expected);
    });
  }
});

describe("voiceAllowed", () => {
  it("needs the tenant's feature flag as well as the template's switch", async () => {
    const input = { companyId: "c", templateId: "t", mode: "recorded" as const };
    expect(await voiceAllowed(settings([true], { "features.recordedVoice": true }) as never, input)).toBe(
      true,
    );
    expect(await voiceAllowed(settings([true], { "features.recordedVoice": false }) as never, input)).toBe(
      false,
    );
    expect(await voiceAllowed(settings([false], { "features.recordedVoice": true }) as never, input)).toBe(
      false,
    );
  });

  it("reads the live flag for live voice and the recorded flag for recorded voice", async () => {
    const s = settings([], { "features.recordedVoice": true, "features.realtimeVoice": false });
    const base = { companyId: "c", templateId: "t" };
    expect(await voiceAllowed(s as never, { ...base, mode: "recorded" })).toBe(true);
    expect(await voiceAllowed(s as never, { ...base, mode: "live" })).toBe(false);
  });
});

describe("tenantInvitationEmail (D-189)", () => {
  const base = {
    companyName: "Acme Oy",
    productName: "Discovery",
    signInUrl: "https://app.example.com/auth/signin?email=a%40b.fi",
  };

  it("is written in the tenant's language and carries the sign-in link and no token", () => {
    const en = tenantInvitationEmail({ ...base, language: "en" });
    const fi = tenantInvitationEmail({ ...base, language: "fi" });
    expect(en.subject).toBe("You have been invited as an admin: Acme Oy");
    expect(fi.subject).toBe("Sinut on kutsuttu ylläpitäjäksi: Acme Oy");
    for (const m of [en, fi]) {
      expect(m.text).toContain(base.signInUrl);
      expect(m.text).toContain("Acme Oy");
    }
    expect(fi.text).toContain("Kirjaudu sisään");
    expect(en.text).not.toContain("Kirjaudu");
  });
});

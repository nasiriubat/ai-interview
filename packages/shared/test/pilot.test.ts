import { describe, expect, it } from "vitest";
import { PILOT_LIMITS, PilotFormSchema, PilotRequestSchema, SETTINGS } from "../src/index.js";

const valid = {
  name: "Aino Virtanen",
  email: "aino@example.fi",
  company: "Example Oy",
  role: "Head of Operations",
  companySize: "50-249",
  interest: "both",
  consent: true,
} as const;

describe("pilot request contract", () => {
  it("accepts a complete request and trims what was typed", () => {
    const parsed = PilotRequestSchema.parse({ ...valid, name: "  Aino Virtanen  ", participants: "11-30" });
    expect(parsed.name).toBe("Aino Virtanen");
    expect(parsed.participants).toBe("11-30");
  });

  it.each(["name", "email", "company", "role", "companySize", "interest", "consent"] as const)(
    "requires %s",
    (field) => {
      const { [field]: _omitted, ...rest } = valid;
      expect(PilotRequestSchema.safeParse(rest).success).toBe(false);
    },
  );

  it("takes only true as consent", () => {
    expect(PilotRequestSchema.safeParse({ ...valid, consent: false }).success).toBe(false);
  });

  it.each(["not-an-email", "a@b", "a b@example.com", "x@example.com\r\nBcc: victim@example.com"])(
    "refuses %j as an email address",
    (email) => {
      expect(PilotRequestSchema.safeParse({ ...valid, email }).success).toBe(false);
    },
  );

  it("refuses a line break in a one-line field, which would otherwise reach a mail header", () => {
    expect(PilotRequestSchema.safeParse({ ...valid, company: "Acme\r\nBcc: x@y.z" }).success).toBe(false);
    expect(PilotRequestSchema.safeParse({ ...valid, name: "Aino\nVirtanen" }).success).toBe(false);
  });

  it("caps every field", () => {
    const long = (n: number): string => "x".repeat(n + 1);
    for (const [field, max] of [
      ["name", PILOT_LIMITS.name],
      ["company", PILOT_LIMITS.company],
      ["role", PILOT_LIMITS.role],
      ["message", PILOT_LIMITS.message],
      ["website", PILOT_LIMITS.website],
      ["ticket", PILOT_LIMITS.ticket],
    ] as const) {
      expect(PilotRequestSchema.safeParse({ ...valid, [field]: long(max) }).success, field).toBe(false);
    }
    expect(
      PilotRequestSchema.safeParse({ ...valid, message: "x".repeat(PILOT_LIMITS.message) }).success,
    ).toBe(true);
  });

  it("refuses values outside the lists", () => {
    expect(PilotRequestSchema.safeParse({ ...valid, companySize: "10000" }).success).toBe(false);
    expect(PilotRequestSchema.safeParse({ ...valid, interest: "other" }).success).toBe(false);
    expect(PilotRequestSchema.safeParse({ ...valid, participants: "5" }).success).toBe(false);
  });

  it("leaves the hidden fields out of what the browser checks", () => {
    expect(Object.keys(PilotFormSchema.shape)).not.toContain("website");
    expect(Object.keys(PilotFormSchema.shape)).not.toContain("ticket");
  });

  it("has a platform-only recipient setting that defaults to empty", () => {
    const def = SETTINGS["sales.pilotRequestEmail"];
    expect(def.default).toBe("");
    expect(def.scopes).toEqual(["platform"]);
    expect(def.schema.safeParse("sales@example.com").success).toBe(true);
    expect(def.schema.safeParse("nope").success).toBe(false);
  });
});

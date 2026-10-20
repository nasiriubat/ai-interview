import { SessionStateSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { withFormProfile } from "../src/sessions/prisma-store.js";

/** The details form feeds the interview's profile, so the first question does not ask it again. */
describe("withFormProfile", () => {
  const state = (profile: object = {}) => SessionStateSchema.parse({ profile });

  it("takes the role and department the participant typed, trimmed", () => {
    const s = withFormProfile(state(), { role: " AP clerk ", department: "Finance" });
    expect(s.profile).toMatchObject({ role: "AP clerk", department: "Finance" });
  });

  it("keeps what the interview has learned over what the form said", () => {
    const s = withFormProfile(state({ role: "Accounts payable lead" }), { role: "AP clerk" });
    expect(s.profile.role).toBe("Accounts payable lead");
  });

  it("ignores blank, non-text and missing fields", () => {
    expect(withFormProfile(state(), { role: "  ", department: 3 }).profile.role).toBeUndefined();
    expect(withFormProfile(state(), null).profile.department).toBeUndefined();
  });
});

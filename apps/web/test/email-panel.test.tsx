import { describe, expect, it } from "vitest";
import {
  emailAddressError,
  initialSmtpDraft,
  smtpDraftBody,
  smtpDraftDirty,
  smtpDraftErrors,
} from "@/components/admin/settings/EmailPanel";

const view = {
  set: {
    host: "smtp.example.com",
    port: 587,
    security: "starttls" as const,
    username: "u",
    passwordSet: true,
  },
  effective: "tenant" as const,
  envConfigured: false,
};

describe("the mail server draft", () => {
  it("starts clean from what the API says, and a password is never part of it", () => {
    const d = initialSmtpDraft(view);
    expect(d).toMatchObject({ host: "smtp.example.com", port: "587", username: "u", password: "" });
    expect(smtpDraftDirty(d, initialSmtpDraft(view))).toBe(false);
  });

  it("defaults to STARTTLS on 587 when nothing is set", () => {
    expect(initialSmtpDraft(null)).toMatchObject({ host: "", port: "587", security: "starttls" });
  });

  it("keeps the stored password unless one is typed or removal is chosen", () => {
    const d = initialSmtpDraft(view);
    expect(smtpDraftBody(d).password).toBe("__unchanged__");
    expect(smtpDraftBody({ ...d, password: "new" }).password).toBe("new");
    expect(smtpDraftBody({ ...d, passwordRemoved: true }).password).toBeNull();
  });

  it("names a bad host and a bad port at the field", () => {
    const d = initialSmtpDraft(view);
    expect(smtpDraftErrors({ ...d, host: "" }).host).toBeTruthy();
    expect(smtpDraftErrors({ ...d, host: "https://x.example/" }).host).toBeTruthy();
    expect(smtpDraftErrors({ ...d, port: "0" }).port).toBeTruthy();
    expect(smtpDraftErrors({ ...d, port: "70000" }).port).toBeTruthy();
    expect(smtpDraftErrors(d)).toEqual({});
  });

  it("accepts a plain or a named sender address", () => {
    expect(emailAddressError("a@b.co")).toBeUndefined();
    expect(emailAddressError("Acme <hello@acme.co>")).toBeUndefined();
    expect(emailAddressError("nope")).toBeTruthy();
    expect(emailAddressError("")).toBeUndefined();
  });
});

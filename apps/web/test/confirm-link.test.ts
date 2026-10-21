import { describe, expect, it } from "vitest";
import { confirmLinkFor, readConfirmParams } from "@/lib/auth/confirm-link";

const TOKEN = "d38eddb2ca259787584e4fe7986828311d600c8705b6de2d56ef7730582ccaf7";
const ORIGIN = "https://aiscope.example";

describe("the emailed sign-in link goes to a confirmation page", () => {
  it("keeps the origin and the token, email and return path, and drops the callback path", () => {
    const link = confirmLinkFor(
      `${ORIGIN}/api/auth/callback/nodemailer?callbackUrl=${encodeURIComponent(`${ORIGIN}/admin`)}&token=${TOKEN}&email=a%40b.fi`,
    );
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/auth/confirm`);
    expect(url.searchParams.get("token")).toBe(TOKEN);
    expect(url.searchParams.get("email")).toBe("a@b.fi");
    expect(url.searchParams.get("callbackUrl")).toBe(`${ORIGIN}/admin`);
    expect(link).not.toContain("/api/auth/callback");
  });

  it("accepts only our own tokens and addresses, and only a return path on this site", () => {
    expect(readConfirmParams({ token: TOKEN, email: "a@b.fi" }, ORIGIN)).toEqual({
      token: TOKEN,
      email: "a@b.fi",
    });
    expect(readConfirmParams({ token: "short", email: "a@b.fi" }, ORIGIN)).toBeNull();
    expect(readConfirmParams({ token: `${TOKEN}"><script>`, email: "a@b.fi" }, ORIGIN)).toBeNull();
    expect(readConfirmParams({ token: TOKEN, email: "nobody" }, ORIGIN)).toBeNull();
    expect(
      readConfirmParams({ token: TOKEN, email: "a@b.fi", callbackUrl: "https://evil.example/x" }, ORIGIN),
    ).toEqual({
      token: TOKEN,
      email: "a@b.fi",
    });
    expect(
      readConfirmParams({ token: TOKEN, email: "a@b.fi", callbackUrl: "/admin/campaigns" }, ORIGIN)
        ?.callbackUrl,
    ).toBe(`${ORIGIN}/admin/campaigns`);
  });
});

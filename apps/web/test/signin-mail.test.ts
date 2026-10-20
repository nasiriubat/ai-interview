import { describe, expect, it } from "vitest";
import { signInMailLocale, signInMessage } from "@/lib/auth/signin-mail";

/*
 * The staff sign-in email (simulation 2026-10-15): Auth.js's default was titled "Sign in to
 * localhost:3300" and named no product.
 */
const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe("the sign-in email", () => {
  it("names the product, carries the link, and says it works once and when it expires", () => {
    const url = "https://discovery.example.org/api/auth/callback/nodemailer?token=abc&email=a%40b.example";
    const m = signInMessage({ url, productName: "Kestrel Discovery", locale: "en", hours: 24 });
    expect(m.subject).toBe("Your sign-in link for Kestrel Discovery");
    expect(m.subject).not.toMatch(/localhost|discovery\.example\.org/);
    expect(m.text).toContain(url);
    expect(m.text).toMatch(/works once and expires in 24 hours/);
    expect(m.text).toMatch(/did not ask/);
    expect(m.html).toContain(url.replace(/&/g, "&amp;"));
  });

  it("escapes the product name in the HTML and falls back when it is blank", () => {
    const m = signInMessage({ url: "https://x.example/a", productName: "<b>Acme</b>", locale: "en" });
    expect(m.html).not.toContain("<b>Acme</b>");
    expect(m.html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(signInMessage({ url: "https://x.example/a", productName: " ", locale: "en" }).subject).toMatch(
      /AIScope$/,
    );
  });

  it("speaks Finnish when the person chose it, by cookie first and then the browser", () => {
    expect(signInMailLocale(headers({ cookie: "a=1; lang=fi" }))).toBe("fi");
    expect(signInMailLocale(headers({ cookie: "lang=en", "accept-language": "fi-FI" }))).toBe("en");
    expect(signInMailLocale(headers({ "accept-language": "fi-FI,fi;q=0.9" }))).toBe("fi");
    expect(signInMailLocale(undefined)).toBe("en");
    const fi = signInMessage({ url: "https://x.example/a", productName: "Kestrel", locale: "fi", hours: 24 });
    expect(fi.subject).toBe("Kirjautumislinkkisi palveluun Kestrel");
    expect(fi.text).toMatch(/toimii kerran/);
  });
});
